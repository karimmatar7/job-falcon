import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../../src/services/scheduling/scheduler.js";
import type { SchedulerTimers } from "../../src/services/scheduling/scheduler.js";
import type { JobSearchFn } from "../../src/services/scheduling/searchRunner.js";
import { Notifier } from "../../src/services/scheduling/notifications.js";
import type { NotificationSender } from "../../src/services/scheduling/notifications.js";
import { formatWallClock } from "../../src/services/scheduling/scheduleTime.js";
import {
  createInitialState,
  InMemoryStateStore,
} from "../../src/services/state/stateStore.js";
import type { StateStore } from "../../src/services/state/stateStore.js";
import { makeJobSearchResult, silentLogger } from "../testKit.js";

/**
 * Regression tests for schedule-time timing behaviour in Europe/London.
 *
 * 2026-10-12 is BST (UTC+1; the clocks do not fall back until 2026-10-25), so
 * 23:17 London == 22:17Z and 00:30 on 13 Oct == 23:30Z on 12 Oct.
 */

/** 2026-10-12 22:16 UTC == 23:16 BST in Europe/London. */
const NOW = new Date("2026-10-12T22:16:00.000Z");

/** Timer seam that records the delay of each armed timer so tests can assert
 * that a schedule change replaces the old timer instead of stacking or leaving
 * a stale one. */
class RecordingTimers implements SchedulerTimers {
  private readonly timers = new Map<number, { handler: () => void; ms: number }>();
  private nextId = 0;

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { handler, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  delays(): number[] {
    return [...this.timers.values()].map((entry) => entry.ms);
  }

  fireAll(): void {
    const entries = [...this.timers.values()];
    this.timers.clear();
    for (const entry of entries) entry.handler();
  }
}

interface Setup {
  scheduler: Scheduler;
  store: StateStore;
  search: ReturnType<typeof vi.fn>;
  timers: RecordingTimers;
  /** Mutable fake clock; advance with `clock.set(...)` to simulate time passing. */
  clock: { current: Date; set(at: Date): void };
}

function setup(initialNow: Date = NOW, overrides: { store?: StateStore } = {}): Setup {
  const store = overrides.store ?? new InMemoryStateStore();
  const timers = new RecordingTimers();
  const search = vi.fn(async () => makeJobSearchResult([]));
  const sender = vi.fn(async () => 1);
  const clock = {
    current: initialNow,
    set(at: Date): void {
      this.current = at;
    },
  };
  const now = (): Date => clock.current;
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
    timers,
  });
  return { scheduler, store, search, timers, clock };
}

describe("schedule time changes (Europe/London, BST)", () => {
  it("re-arms the running timer immediately when the time changes", async () => {
    const { scheduler, store, timers, search } = setup();
    await scheduler.start();

    // Default 08:00 BST = 07:00Z; at 22:16Z the next occurrence is tomorrow.
    expect((await store.get()).schedule.nextRunAt).toBe("2026-10-13T07:00:00.000Z");
    expect(timers.pendingCount).toBe(1);

    // /schedule time 23:20 (4 minutes ahead of 23:16 BST = 22:20Z today).
    await store.update((draft) => {
      draft.schedule.settings.time = "23:20";
    });
    await scheduler.reschedule();

    const state = await store.get();
    expect(state.schedule.nextRunAt).toBe("2026-10-12T22:20:00.000Z");
    // The old long-delay timer must be gone and one 4-minute timer armed.
    expect(timers.pendingCount).toBe(1);
    expect(timers.delays()).toEqual([4 * 60_000]);
    expect(search).not.toHaveBeenCalled();
  });

  it("runs the search at the new time a few minutes ahead", async () => {
    const { scheduler, store, timers, search, clock } = setup();
    await scheduler.start();
    await store.update((draft) => {
      draft.schedule.settings.time = "23:20";
    });
    await scheduler.reschedule();
    expect(timers.delays()).toEqual([4 * 60_000]);

    // Simulate the four minutes elapsing, then fire the armed timer.
    clock.set(new Date("2026-10-12T22:20:01.000Z"));
    timers.fireAll();
    await vi.waitFor(() => expect(timers.pendingCount).toBe(1));

    expect(search).toHaveBeenCalledTimes(1);
    const state = await store.get();
    expect(state.schedule.lastRun?.trigger).toBe("schedule");
    expect(state.schedule.lastRun?.status).toBe("success");
    // Re-armed for tomorrow 23:20 BST.
    expect(state.schedule.nextRunAt).toBe("2026-10-13T22:20:00.000Z");
  });

  it("defers to tomorrow when the time is set to the already-elapsed current minute", async () => {
    // 22:17:30Z == 23:17:30 BST, so 23:17 today has already passed.
    const { scheduler, store, timers } = setup(new Date("2026-10-12T22:17:30.000Z"));
    await scheduler.start();
    await store.update((draft) => {
      draft.schedule.settings.time = "23:17";
    });
    await scheduler.reschedule();

    const state = await store.get();
    expect(state.schedule.nextRunAt).toBe("2026-10-13T22:17:00.000Z");
    expect(state.schedule.lastRun).toBeUndefined();
    expect(timers.pendingCount).toBe(1);
    // 24h minus the 30 seconds already elapsed in that minute.
    expect(timers.delays()).toEqual([24 * 60 * 60_000 - 30_000]);
  });

  it("crosses midnight in Europe/London correctly", async () => {
    // 23:15Z == 00:15 BST on 13 October.
    const { scheduler, store, timers } = setup(new Date("2026-10-12T23:15:00.000Z"));
    await scheduler.start();
    await store.update((draft) => {
      draft.schedule.settings.time = "00:30";
    });
    await scheduler.reschedule();

    const state = await store.get();
    // 00:30 BST on the 13th == 23:30Z on the 12th, still ahead of 23:15Z.
    expect(state.schedule.nextRunAt).toBe("2026-10-12T23:30:00.000Z");
    expect(timers.delays()).toEqual([15 * 60_000]);
    expect(formatWallClock(new Date("2026-10-12T23:30:00.000Z"), "Europe/London")).toBe(
      "2026-10-13 00:30",
    );
  });

  it("runs the catch-up when the stored next run is exactly due at boot", async () => {
    const state = createInitialState();
    state.schedule.nextRunAt = "2026-10-12T22:16:00.000Z"; // exactly NOW
    const { scheduler, search } = setup(NOW, { store: new InMemoryStateStore(state) });

    await scheduler.start();

    expect(search).toHaveBeenCalledTimes(1);
  });

  it("persists the next run without arming a timer when not started", async () => {
    // A command-only environment (webhook/serverless) deliberately persists
    // the schedule without arming a timer. This is also why the old wiring
    // (scheduler.start() after the blocking bot.start()) showed a correct
    // /status countdown while nothing was ever scheduled to run.
    const { scheduler, store, timers } = setup();
    await scheduler.reschedule();

    const state = await store.get();
    expect(state.schedule.nextRunAt).toBe("2026-10-13T07:00:00.000Z");
    expect(timers.pendingCount).toBe(0);
  });
});