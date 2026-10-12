import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../../src/services/scheduling/scheduler.js";
import type { JobSearchFn } from "../../src/services/scheduling/searchRunner.js";
import type { NotificationSender } from "../../src/services/scheduling/notifications.js";
import { Notifier } from "../../src/services/scheduling/notifications.js";
import {
  InMemoryStateStore,
  createInitialState,
  MAX_RECENT_RUNS,
} from "../../src/services/state/stateStore.js";
import type { StateStore } from "../../src/services/state/stateStore.js";
import { identityKey, jobIdentityKeys } from "../../src/services/scheduling/jobIdentity.js";
import type { JobSearchResult } from "../../src/services/jobSearch.js";
import {
  SCHEDULED_SEARCH_COMPLETE_MESSAGE,
  SCHEDULED_SEARCH_FAILED_MESSAGE,
  buildScheduledSearchIncompleteMessage,
} from "../../src/messages.js";
import {
  FakeTimers,
  makeJobSearchResult,
  makeVacancy,
  silentLogger,
} from "../testKit.js";

const NOW = new Date("2026-06-01T09:00:00.000Z");

function makeScheduler(
  overrides: {
    store?: StateStore;
    search?: ReturnType<typeof vi.fn>;
    chatId?: number;
    maxNotificationsPerRun?: number;
  } = {},
) {
  const store = overrides.store ?? new InMemoryStateStore();
  const timers = new FakeTimers();
  const search =
    overrides.search ?? vi.fn(async () => makeJobSearchResult([]));
  const sender = vi.fn(async () => 1);
  const notifier = new Notifier({
    store,
    sender: sender as unknown as NotificationSender,
    logger: silentLogger,
    now: () => NOW,
  });
  const scheduler = new Scheduler({
    store,
    search: search as unknown as JobSearchFn,
    notifier,
    logger: silentLogger,
    chatId: overrides.chatId ?? 42,
    now: () => NOW,
    timers,
    ...(overrides.maxNotificationsPerRun === undefined
      ? {}
      : { maxNotificationsPerRun: overrides.maxNotificationsPerRun }),
  });
  return { scheduler, store, search, sender, notifier, timers };
}

describe("start", () => {
  it("computes and persists the next run and arms a timer", async () => {
    const { scheduler, store, search, timers } = makeScheduler();
    await scheduler.start();

    const state = await store.get();
    expect(state.schedule.nextRunAt).toBe("2026-06-02T07:00:00.000Z");
    expect(timers.pendingCount).toBe(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not run a catch-up when no next run is stored", async () => {
    const { scheduler, search } = makeScheduler();
    await scheduler.start();
    expect(search).not.toHaveBeenCalled();
  });

  it("catches up a missed run once on restart", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const { scheduler, store, search, timers } = makeScheduler({
      store: new InMemoryStateStore(state),
    });

    await scheduler.start();

    expect(search).toHaveBeenCalledTimes(1);
    const persisted = await store.get();
    expect(persisted.schedule.lastRun?.trigger).toBe("restart");
    expect(persisted.schedule.lastRun?.status).toBe("success");
    expect(persisted.schedule.nextRunAt).toBe("2026-06-02T07:00:00.000Z");
    expect(timers.pendingCount).toBe(1);
  });

  it("does not catch up when scheduling is disabled", async () => {
    const state = createInitialState({ scheduleEnabled: false });
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const { scheduler, store, search, timers } = makeScheduler({
      store: new InMemoryStateStore(state),
    });

    await scheduler.start();

    expect(search).not.toHaveBeenCalled();
    const persisted = await store.get();
    expect(persisted.schedule.nextRunAt).toBeUndefined();
    expect(timers.pendingCount).toBe(0);
  });

  it("arms no timer when scheduling is disabled", async () => {
    const { scheduler, timers } = makeScheduler({
      store: new InMemoryStateStore(createInitialState({ scheduleEnabled: false })),
    });
    await scheduler.start();
    expect(timers.pendingCount).toBe(0);
  });

  it("is idempotent", async () => {
    const { scheduler, search, timers } = makeScheduler();
    await scheduler.start();
    await scheduler.start();
    expect(search).not.toHaveBeenCalled();
    expect(timers.pendingCount).toBe(1);
  });

  it("marks an interrupted previous run as failed", async () => {
    const store = new InMemoryStateStore(createInitialState());
    await store.update((draft) => {
      draft.schedule.lastRun = {
        startedAt: "2026-05-31T07:00:00.000Z",
        trigger: "schedule",
        status: "running",
        discovered: 0,
        notified: 0,
        failed: 0,
        summarised: 0,
      };
    });
    const { scheduler } = makeScheduler({ store });
    await scheduler.start();

    const state = await store.get();
    expect(state.schedule.lastRun?.status).toBe("failed");
    expect(state.schedule.lastRun?.error).toContain("restart");
    expect(state.schedule.recentRuns).toHaveLength(1);
    expect(state.schedule.recentRuns[0]?.status).toBe("failed");
  });

  it("retries pending notifications after a restart", async () => {
    const store = new InMemoryStateStore(createInitialState());
    const job = makeVacancy();
    await store.update((draft) => {
      draft.schedule.settings.enabled = true;
      draft.notifications.pending.push({
        key: identityKey(job),
        keys: jobIdentityKeys(job),
        chatId: 42,
        vacancy: job,
        attempts: 0,
        createdAt: "2026-05-31T07:00:00.000Z",
      });
    });
    const { scheduler, sender } = makeScheduler({ store });
    await scheduler.start();

    expect(sender).toHaveBeenCalledTimes(1);
    expect((await store.get()).notifications.pending).toHaveLength(0);
  });

  it("keeps pending notifications when alerts are paused", async () => {
    const store = new InMemoryStateStore(createInitialState());
    const job = makeVacancy();
    await store.update((draft) => {
      draft.schedule.settings.alertsPaused = true;
      draft.notifications.pending.push({
        key: identityKey(job),
        keys: jobIdentityKeys(job),
        chatId: 42,
        vacancy: job,
        attempts: 0,
        createdAt: "2026-05-31T07:00:00.000Z",
      });
    });
    const { scheduler, sender } = makeScheduler({ store });
    await scheduler.start();

    expect(sender).not.toHaveBeenCalled();
    expect((await store.get()).notifications.pending).toHaveLength(1);
  });
});

describe("run", () => {
  it("executes a full successful run and records it", async () => {
    const search = vi.fn(async () =>
      makeJobSearchResult([
        makeVacancy(),
        makeVacancy({ id: "job-2", applicationUrl: "https://example.com/apply/2" }),
      ]),
    );
    const { scheduler, store, sender } = makeScheduler({ search });

    const record = await scheduler.run("manual");

    expect(record.status).toBe("success");
    expect(record.trigger).toBe("manual");
    expect(record.discovered).toBe(2);
    expect(record.notified).toBe(2);
    expect(record.failed).toBe(0);
    expect(sender).toHaveBeenCalledTimes(2);

    expect(search).toHaveBeenCalledWith({ keywords: ["software developer"], limit: 10 });

    const state = await store.get();
    expect(state.schedule.lastRun?.status).toBe("success");
    expect(state.schedule.recentRuns).toHaveLength(1);
    expect(state.schedule.nextRunAt).toBe("2026-06-02T07:00:00.000Z");
    expect(state.notifications.seen[identityKey(makeVacancy())]?.status).toBe("notified");
  });

  it("forwards the configured location in the search query", async () => {
    const state = createInitialState({ scheduleLocation: "Leeds" });
    const search = vi.fn(async () => makeJobSearchResult([]));
    const { scheduler } = makeScheduler({ store: new InMemoryStateStore(state), search });

    await scheduler.run("manual");

    expect(search).toHaveBeenCalledWith({
      keywords: ["software developer"],
      limit: 10,
      location: "Leeds",
    });
  });

  it("caps notifications per run and summarises the rest", async () => {
    const jobs = Array.from({ length: 7 }, (_, index) =>
      makeVacancy({
        id: `job-${index}`,
        applicationUrl: `https://example.com/apply/${index}`,
      }),
    );
    const search = vi.fn(async () => makeJobSearchResult(jobs));
    const { scheduler, sender, store } = makeScheduler({ search });

    const record = await scheduler.run("schedule");

    expect(record.discovered).toBe(7);
    expect(record.notified).toBe(5);
    expect(record.summarised).toBe(2);
    // 5 individual alerts + 1 summary message.
    expect(sender).toHaveBeenCalledTimes(6);
    expect(sender).toHaveBeenLastCalledWith({
      chatId: 42,
      text: expect.stringContaining("2 more new match(es)"),
    });
    const state = await store.get();
    expect(state.schedule.lastRun?.summarised).toBe(2);
  });

  it("never alerts the same job twice across runs", async () => {
    const search = vi.fn(async () => makeJobSearchResult([makeVacancy()]));
    const { scheduler, sender } = makeScheduler({ search });

    const first = await scheduler.run("schedule");
    expect(first.notified).toBe(1);

    const second = await scheduler.run("schedule");
    expect(second.discovered).toBe(0);
    expect(second.notified).toBe(0);

    // The job alert is sent once; the second send is the scheduled-search
    // completion notice (nothing new was found), never a duplicate job card.
    const jobAlertCalls = (sender.mock.calls as unknown as Array<[{ parseMode?: string }]>).filter(
      ([arg]) => arg.parseMode === "MarkdownV2",
    );
    expect(jobAlertCalls).toHaveLength(1);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender).toHaveBeenLastCalledWith({
      chatId: 42,
      text: expect.stringContaining("No new relevant vacancies found today."),
    });
  });

  it("skips a scheduled run when scheduling is disabled", async () => {
    const { scheduler, search } = makeScheduler({
      store: new InMemoryStateStore(createInitialState({ scheduleEnabled: false })),
    });

    const record = await scheduler.run("schedule");

    expect(record.status).toBe("skipped");
    expect(record.error).toContain("disabled");
    expect(search).not.toHaveBeenCalled();
  });

  it("still runs on a manual trigger when scheduling is disabled", async () => {
    const search = vi.fn(async () => makeJobSearchResult([]));
    const { scheduler } = makeScheduler({
      store: new InMemoryStateStore(createInitialState({ scheduleEnabled: false })),
      search,
    });

    const record = await scheduler.run("manual");

    expect(record.status).toBe("success");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("records a failure and keeps the bot usable", async () => {
    const search = vi.fn(async () => {
      throw new Error("network down");
    });
    const { scheduler, store } = makeScheduler({ search });

    const record = await scheduler.run("manual");

    expect(record.status).toBe("failed");
    expect(record.error).toContain("network down");
    const state = await store.get();
    expect(state.schedule.lastRun?.status).toBe("failed");
    expect(state.schedule.lastRun?.error).toContain("network down");
    expect(state.schedule.recentRuns).toHaveLength(1);
  });

  it("skips a run while another is in progress", async () => {
    let resolveSearch!: (result: JobSearchResult) => void;
    const gate = new Promise<JobSearchResult>((resolve) => {
      resolveSearch = resolve;
    });
    const search = vi.fn(async () => gate);
    const { scheduler } = makeScheduler({ search });

    const first = scheduler.run("manual");
    await vi.waitFor(() => expect(search).toHaveBeenCalled());

    const second = scheduler.run("manual");
    resolveSearch(makeJobSearchResult([makeVacancy()]));

    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    expect(firstRecord.status).toBe("success");
    expect(secondRecord.status).toBe("skipped");
    expect(secondRecord.error).toContain("already in progress");
  });

  it("queues discoveries while paused without sending anything", async () => {
    const store = new InMemoryStateStore(createInitialState());
    await store.update((draft) => {
      draft.schedule.settings.alertsPaused = true;
    });
    const search = vi.fn(async () => makeJobSearchResult([makeVacancy()]));
    const { scheduler, sender } = makeScheduler({ store, search });

    const record = await scheduler.run("schedule");

    expect(record.status).toBe("success");
    expect(record.discovered).toBe(1);
    expect(record.notified).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    expect((await store.get()).notifications.pending).toHaveLength(1);
  });

  it("flushes queued notifications once alerts resume", async () => {
    const store = new InMemoryStateStore(createInitialState());
    await store.update((draft) => {
      draft.schedule.settings.alertsPaused = true;
    });
    const search = vi.fn(async () => makeJobSearchResult([makeVacancy()]));
    const { scheduler, sender } = makeScheduler({ store, search });

    await scheduler.run("schedule");

    await store.update((draft) => {
      draft.schedule.settings.alertsPaused = false;
    });
    const resumed = await scheduler.run("schedule");

    expect(resumed.discovered).toBe(0);
    expect(resumed.notified).toBe(1);
    expect(sender).toHaveBeenCalledTimes(1);
    expect((await store.get()).notifications.pending).toHaveLength(0);
  });

  it("bounds the recent runs history", async () => {
    const { scheduler, store } = makeScheduler();
    for (let index = 0; index < MAX_RECENT_RUNS + 3; index++) {
      await scheduler.run("manual");
    }
    const state = await store.get();
    expect(state.schedule.recentRuns).toHaveLength(MAX_RECENT_RUNS);
  });
});

describe("scheduled search completion notice", () => {
  it("sends a completion notice when a scheduled run finds nothing new", async () => {
    const { scheduler, sender, store } = makeScheduler();
    await scheduler.start();

    const record = await scheduler.run("schedule");

    expect(record.status).toBe("success");
    expect(record.discovered).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenLastCalledWith({
      chatId: 42,
      text: SCHEDULED_SEARCH_COMPLETE_MESSAGE,
    });
    expect((await store.get()).schedule.lastCompletionNoticeSlot).toBe(
      "2026-06-02T07:00:00.000Z",
    );
  });

  it("does not send the completion notice for a manual search", async () => {
    const { scheduler, sender, store } = makeScheduler();
    await scheduler.start();

    const record = await scheduler.run("manual");

    expect(record.status).toBe("success");
    expect(sender).not.toHaveBeenCalled();
    expect((await store.get()).schedule.lastCompletionNoticeSlot).toBeUndefined();
  });

  it("does not send the completion notice when alerts are paused", async () => {
    const store = new InMemoryStateStore(createInitialState());
    await store.update((draft) => {
      draft.schedule.settings.alertsPaused = true;
    });
    const { scheduler, sender } = makeScheduler({ store });
    await scheduler.start();

    const record = await scheduler.run("schedule");

    expect(record.discovered).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    expect((await store.get()).schedule.lastCompletionNoticeSlot).toBeUndefined();
  });

  it("does not send the completion notice when new vacancies were alerted", async () => {
    const search = vi.fn(async () => makeJobSearchResult([makeVacancy()]));
    const { scheduler, sender } = makeScheduler({ search });
    await scheduler.start();

    const record = await scheduler.run("schedule");

    expect(record.discovered).toBe(1);
    expect(record.notified).toBe(1);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).not.toHaveBeenCalledWith({
      chatId: 42,
      text: SCHEDULED_SEARCH_COMPLETE_MESSAGE,
    });
  });

  it("sends a distinct incomplete notice when a source failed and nothing was found", async () => {
    const search = vi.fn(async () =>
      makeJobSearchResult([], { errors: ["adzuna: 503 Service Unavailable"] }),
    );
    const { scheduler, sender } = makeScheduler({ search });
    await scheduler.start();

    const record = await scheduler.run("schedule");

    expect(record.status).toBe("success");
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenLastCalledWith({
      chatId: 42,
      text: buildScheduledSearchIncompleteMessage(1),
    });
    expect(sender).not.toHaveBeenCalledWith({
      chatId: 42,
      text: SCHEDULED_SEARCH_COMPLETE_MESSAGE,
    });
  });

  it("sends a failure notice and never claims no vacancies when the search throws", async () => {
    const search = vi.fn(async () => {
      throw new Error("network down");
    });
    const { scheduler, sender } = makeScheduler({ search });
    await scheduler.start();

    const record = await scheduler.run("schedule");

    expect(record.status).toBe("failed");
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenLastCalledWith({
      chatId: 42,
      text: SCHEDULED_SEARCH_FAILED_MESSAGE,
    });
    expect(sender).not.toHaveBeenCalledWith({
      chatId: 42,
      text: SCHEDULED_SEARCH_COMPLETE_MESSAGE,
    });
  });

  it("does not repeat the completion notice for the same scheduled slot", async () => {
    const { scheduler, sender } = makeScheduler();
    await scheduler.start();

    await scheduler.run("schedule");
    await scheduler.run("schedule");

    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("suppresses the completion notice on a restart catch-up that already notified the slot", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    state.schedule.lastCompletionNoticeSlot = "2026-05-31T07:00:00.000Z";
    const search = vi.fn(async () => makeJobSearchResult([]));
    const { scheduler, sender } = makeScheduler({
      store: new InMemoryStateStore(state),
      search,
    });

    await scheduler.start();

    // The search still runs; only the duplicate notice is suppressed.
    expect(search).toHaveBeenCalledTimes(1);
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends the completion notice on a restart catch-up that has not notified the slot", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const search = vi.fn(async () => makeJobSearchResult([]));
    const { scheduler, sender } = makeScheduler({
      store: new InMemoryStateStore(state),
      search,
    });

    await scheduler.start();

    expect(search).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenLastCalledWith({
      chatId: 42,
      text: SCHEDULED_SEARCH_COMPLETE_MESSAGE,
    });
  });
});

describe("timers", () => {
  it("fires a scheduled run and re-arms the next timer", async () => {
    const search = vi.fn(async () => makeJobSearchResult([]));
    const { scheduler, timers } = makeScheduler({ search });
    await scheduler.start();
    expect(timers.pendingCount).toBe(1);

    await timers.fireAll();

    await vi.waitFor(() => expect(timers.pendingCount).toBe(1));
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the pending timer", async () => {
    const { scheduler, timers } = makeScheduler();
    await scheduler.start();
    expect(timers.pendingCount).toBe(1);
    scheduler.stop();
    expect(timers.pendingCount).toBe(0);
  });
});

describe("reschedule", () => {
  it("recomputes the next run after a settings change", async () => {
    const { scheduler, store } = makeScheduler();
    await scheduler.start();

    await store.update((draft) => {
      draft.schedule.settings.time = "23:00";
    });
    await scheduler.reschedule();

    const state = await store.get();
    // 23:00 BST on 1 June 2026 is 22:00 UTC, still ahead of the fixed "now".
    expect(state.schedule.nextRunAt).toBe("2026-06-01T22:00:00.000Z");
  });
});