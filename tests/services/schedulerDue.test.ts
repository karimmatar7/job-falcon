import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../src/services/scheduling/scheduler.js";
import type { JobSearchFn } from "../../src/services/scheduling/searchRunner.js";
import type { NotificationSender } from "../../src/services/scheduling/notifications.js";
import { Notifier } from "../../src/services/scheduling/notifications.js";
import {
  FileStateStore,
  InMemoryStateStore,
  createInitialState,
} from "../../src/services/state/stateStore.js";
import type {
  LockableStateStore,
  PersistedState,
  StateStore,
} from "../../src/services/state/stateStore.js";
import type { JobSearchResult } from "../../src/services/jobSearch.js";
import { SCHEDULED_SEARCH_COMPLETE_MESSAGE } from "../../src/messages.js";
import {
  FakeTimers,
  makeJobSearchResult,
  makeVacancy,
  silentLogger,
} from "../testKit.js";

const DEFAULT_NOW = "2026-06-01T09:00:00.000Z";

function makeDueScheduler(
  initial?: PersistedState,
  searchResult: JobSearchResult = makeJobSearchResult([]),
  storeOverride?: StateStore,
) {
  const store = storeOverride ?? new InMemoryStateStore(initial ?? createInitialState());
  let current = new Date(DEFAULT_NOW);
  const now = () => current;
  const search = vi.fn(async () => searchResult);
  const sender = vi.fn(async () => 1);
  const notifier = new Notifier({
    store,
    sender: sender as unknown as NotificationSender,
    logger: silentLogger,
    now,
  });
  const scheduler = new Scheduler({
    store,
    search: search as unknown as JobSearchFn,
    notifier,
    logger: silentLogger,
    chatId: 42,
    now,
    timers: new FakeTimers(),
  });
  return {
    scheduler,
    store,
    search,
    sender,
    notifier,
    setNow: (value: string) => {
      current = new Date(value);
    },
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Scheduler.runIfDue", () => {
  it("arms the next run without running when none is stored yet", async () => {
    const { scheduler, store, search } = makeDueScheduler();

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe("not-due");
    expect(search).not.toHaveBeenCalled();
    // 08:00 Europe/London on 1 June 2026 is 07:00 UTC (BST).
    expect((await store.get()).schedule.nextRunAt).toBe("2026-06-02T07:00:00.000Z");
  });

  it("runs once when due and advances the next run", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const { scheduler, store, search } = makeDueScheduler(state);

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(true);
    expect(outcome.reason).toBe("ran");
    expect(outcome.record?.status).toBe("success");
    expect(search).toHaveBeenCalledTimes(1);
    expect((await store.get()).schedule.nextRunAt).toBe("2026-06-02T07:00:00.000Z");
  });

  it("does not run again for the same slot", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const { scheduler, search } = makeDueScheduler(state);

    const first = await scheduler.runIfDue();
    const second = await scheduler.runIfDue();

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("not-due");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("never runs when scheduling is disabled", async () => {
    const state = createInitialState({ scheduleEnabled: false });
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const { scheduler, search } = makeDueScheduler(state);

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe("disabled");
    expect(search).not.toHaveBeenCalled();
  });

  it("still searches when alerts are paused but sends nothing", async () => {
    const state = createInitialState();
    state.schedule.settings.alertsPaused = true;
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const { scheduler, store, search, sender } = makeDueScheduler(
      state,
      makeJobSearchResult([makeVacancy()]),
    );

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect(sender).not.toHaveBeenCalled();
    expect((await store.get()).notifications.pending).toHaveLength(1);
  });

  it("takes over a run whose lease has expired", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    state.schedule.lastRun = {
      startedAt: "2026-06-01T08:00:00.000Z", // 60 minutes before DEFAULT_NOW
      trigger: "schedule",
      status: "running",
      discovered: 0,
      notified: 0,
      failed: 0,
      summarised: 0,
    };
    const { scheduler, store, search } = makeDueScheduler(state);

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect((await store.get()).schedule.lastRun?.status).toBe("success");
  });

  it("leaves a recent in-progress run alone", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    state.schedule.lastRun = {
      startedAt: "2026-06-01T08:59:00.000Z", // one minute before DEFAULT_NOW
      trigger: "schedule",
      status: "running",
      discovered: 0,
      notified: 0,
      failed: 0,
      summarised: 0,
    };
    const { scheduler, search } = makeDueScheduler(state);

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe("in-progress");
    expect(search).not.toHaveBeenCalled();
  });

  it("computes the next run on the correct side of a DST change", async () => {
    const { scheduler, store, setNow } = makeDueScheduler();
    // British Summer Time starts on 2026-03-29; 08:00 London is 07:00 UTC.
    setNow("2026-03-28T09:00:00.000Z");

    await scheduler.runIfDue();

    expect((await store.get()).schedule.nextRunAt).toBe("2026-03-29T07:00:00.000Z");
  });

  it("fires at the configured wall clock in BST and GMT", async () => {
    const bst = createInitialState();
    bst.schedule.nextRunAt = "2026-03-29T07:00:00.000Z"; // 08:00 London, summer
    const summer = makeDueScheduler(bst);
    summer.setNow("2026-03-29T06:59:00.000Z");
    expect((await summer.scheduler.runIfDue()).reason).toBe("not-due");
    summer.setNow("2026-03-29T07:00:00.000Z");
    expect((await summer.scheduler.runIfDue()).ran).toBe(true);

    const gmt = createInitialState();
    gmt.schedule.nextRunAt = "2026-01-15T08:00:00.000Z"; // 08:00 London, winter
    const winter = makeDueScheduler(gmt);
    winter.setNow("2026-01-15T07:59:00.000Z");
    expect((await winter.scheduler.runIfDue()).reason).toBe("not-due");
    winter.setNow("2026-01-15T08:00:00.000Z");
    expect((await winter.scheduler.runIfDue()).ran).toBe(true);
  });

  it("persists across instances so a second one does not re-run or re-notify", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-due-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "state.json");

    const buildInstance = (nowIso: string) => {
      const store = new FileStateStore({ filePath, logger: silentLogger });
      let current = new Date(nowIso);
      const now = () => current;
      const search = vi.fn(async () => makeJobSearchResult([]));
      const sender = vi.fn(async () => 1);
      const notifier = new Notifier({
        store,
        sender: sender as unknown as NotificationSender,
        logger: silentLogger,
        now,
      });
      const scheduler = new Scheduler({
        store,
        search: search as unknown as JobSearchFn,
        notifier,
        logger: silentLogger,
        chatId: 42,
        now,
        timers: new FakeTimers(),
      });
      return {
        scheduler,
        search,
        sender,
        store,
        setNow: (value: string) => {
          current = new Date(value);
        },
      };
    };

    const first = buildInstance("2026-06-01T09:00:00.000Z");
    // Seed the persisted schedule so the run is due, exactly as /schedule would.
    await first.store.update((draft) => {
      draft.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    });
    expect((await first.scheduler.runIfDue()).ran).toBe(true);

    // A different serverless instance reads the same durable document.
    const second = buildInstance("2026-06-01T09:05:00.000Z");
    const outcome = await second.scheduler.runIfDue();

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe("not-due");
    expect(second.search).not.toHaveBeenCalled();
    expect(second.sender).not.toHaveBeenCalled();
    // The first instance's single completion notice is the only one sent.
    expect(first.sender).toHaveBeenCalledTimes(1);
    expect(first.sender).toHaveBeenCalledWith({
      chatId: 42,
      text: SCHEDULED_SEARCH_COMPLETE_MESSAGE,
    });
  });
});

class FakeLockableStore implements LockableStateStore {
  acquired = 0;
  released = 0;

  constructor(
    private readonly inner: InMemoryStateStore,
    private readonly granted: boolean,
  ) {}

  get(): Promise<PersistedState> {
    return this.inner.get();
  }

  update(mutator: (draft: PersistedState) => void): Promise<PersistedState> {
    return this.inner.update(mutator);
  }

  async acquireLock(): Promise<boolean> {
    this.acquired += 1;
    return this.granted;
  }

  async releaseLock(): Promise<void> {
    this.released += 1;
  }
}

describe("Scheduler.runIfDue with a lockable store", () => {
  it("skips without running when another instance holds the lock", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const lock = new FakeLockableStore(new InMemoryStateStore(state), false);
    const { scheduler, search } = makeDueScheduler(undefined, undefined, lock);

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe("in-progress");
    expect(search).not.toHaveBeenCalled();
    expect(lock.acquired).toBe(1);
    expect(lock.released).toBe(0);
  });

  it("runs while holding the lock and releases it afterwards", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    const lock = new FakeLockableStore(new InMemoryStateStore(state), true);
    const { scheduler, search } = makeDueScheduler(undefined, undefined, lock);

    const outcome = await scheduler.runIfDue();

    expect(outcome.ran).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect(lock.acquired).toBe(1);
    expect(lock.released).toBe(1);
  });

  it("releases the lock even when the due check fails", async () => {
    const lock = new FakeLockableStore(new InMemoryStateStore(createInitialState()), true);
    // A store whose reads fail exercises the finally path.
    const failing: LockableStateStore = {
      get: async () => {
        throw new Error("redis down");
      },
      update: lock.update.bind(lock),
      acquireLock: lock.acquireLock.bind(lock),
      releaseLock: lock.releaseLock.bind(lock),
    };
    const { scheduler } = makeDueScheduler(undefined, undefined, failing);

    await expect(scheduler.runIfDue()).rejects.toThrow("redis down");
    expect(lock.acquired).toBe(1);
    expect(lock.released).toBe(1);
  });
});
