import { MIN_ALTERNATIVE_SCORE } from "../jobSearch.js";
import {
  DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
  MAX_RECENT_RUNS,
} from "../state/stateStore.js";
import type { RunRecord, RunTrigger, ScheduleSettings, StateStore } from "../state/stateStore.js";
import { isLockableStateStore } from "../state/stateStore.js";
import type { Logger } from "../../utils/logger.js";
import { nextRunAfter } from "./scheduleTime.js";
import type { JobSearchFn } from "./searchRunner.js";
import type { Notifier } from "./notifications.js";
import type { JobSearchResult } from "../jobSearch.js";
import {
  SCHEDULED_SEARCH_COMPLETE_MESSAGE,
  SCHEDULED_SEARCH_FAILED_MESSAGE,
  buildScheduledSearchIncompleteMessage,
} from "../../messages.js";

/** Injectable timer seam so tests never wait on the real clock. */
export interface SchedulerTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultSchedulerTimers: SchedulerTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  readonly store: StateStore;
  readonly search: JobSearchFn;
  readonly notifier: Notifier;
  readonly logger: Logger;
  /** Only this chat ever receives alerts (the authorised user's private chat). */
  readonly chatId: number;
  readonly minAlternativeScore?: number;
  readonly maxNotificationsPerRun?: number;
  readonly now?: () => Date;
  readonly timers?: SchedulerTimers;
}

/**
 * How long a persisted `running` run is trusted before a *different* process
 * (for example a fresh serverless instance handling the scheduled-search
 * endpoint) treats it as crashed and takes over. Long-polling restarts recover
 * immediately via {@link Scheduler.start}; this lease only governs the
 * stateless/serverless trigger path.
 */
export const RUN_LEASE_MS = 10 * 60 * 1000;

/** The result of an out-of-process trigger; `ran` is true only on a real run. */
export interface DueRunOutcome {
  /** True only when the search actually executed. */
  readonly ran: boolean;
  readonly reason: "ran" | "disabled" | "not-due" | "in-progress" | "already-running";
  readonly record?: RunRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseIso(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Runs the morning search and the notification fan-out.
 *
 * Reliability properties:
 * - Only one run can be in progress at a time (in-memory guard), so overlapping
 *   timers/restarts cannot produce a double batch.
 * - Discovery is persisted (seen keys + pending queue) before any Telegram
 *   send, so a crash between the two cannot lose an alert.
 * - On start, a run left `running` by a crash is marked interrupted, pending
 *   notifications are retried, and a missed run is caught up once. Duplicate
 *   alerts are impossible because the seen-set is durable.
 */
export class Scheduler {
  private readonly store: StateStore;
  private readonly search: JobSearchFn;
  private readonly notifier: Notifier;
  private readonly logger: Logger;
  private readonly chatId: number;
  private readonly minAlternativeScore: number;
  private readonly maxNotificationsPerRun: number;
  private readonly now: () => Date;
  private readonly timers: SchedulerTimers;

  private timer: unknown;
  private running = false;
  private started = false;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.search = options.search;
    this.notifier = options.notifier;
    this.logger = options.logger;
    this.chatId = options.chatId;
    this.minAlternativeScore = options.minAlternativeScore ?? MIN_ALTERNATIVE_SCORE;
    this.maxNotificationsPerRun =
      options.maxNotificationsPerRun ?? DEFAULT_MAX_NOTIFICATIONS_PER_RUN;
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? defaultSchedulerTimers;
  }

  /** Start timers, recover from a crash, and catch up a missed run once. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.recoverInterruptedRun();
    await this.recoverPending();

    const state = await this.store.get();
    this.logger.info("Scheduler started", {
      now: this.now().toISOString(),
      enabled: state.schedule.settings.enabled,
      scheduleTime: state.schedule.settings.time,
      timezone: state.schedule.settings.timeZone,
      storedNextRunAt: state.schedule.nextRunAt,
    });
    if (state.schedule.settings.enabled) {
      const stored = parseIso(state.schedule.nextRunAt);
      if (stored !== undefined && stored.getTime() <= this.now().getTime()) {
        this.logger.info("Missed scheduled run detected; running once to catch up");
        await this.run("restart");
      }
    }

    await this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Recompute and persist the next run, and (re)arm the timer when started. */
  async reschedule(): Promise<void> {
    await this.scheduleNext();
  }

  /**
   * Execute the scheduled search only when a run is genuinely due.
   *
   * This is the entry point for out-of-process triggers (a Vercel Cron job or an
   * external scheduler calling the protected endpoint). Unlike a timer callback
   * it can fire at an arbitrary cadence and from overlapping instances, so it is
   * deliberately idempotent:
   *
   * - `/schedule off` (`enabled=false`) never runs.
   * - Due-ness comes from the persisted `nextRunAt`, so the configured IANA
   *   timezone and daylight-saving changes are handled by {@link nextRunAfter}
   *   rather than by the trigger's own wall clock.
   * - A missing `nextRunAt` is armed (computed and persisted) without running,
   *   so a fresh stateless deployment self-heals on its first trigger.
   * - A `running` record left by a crashed process is taken over only after
   *   {@link RUN_LEASE_MS}; otherwise the call is skipped.
   * - Duplicate alerts cannot happen: discoveries are de-duplicated by the
   *   durable seen-set and the completion notice is bound to the run's slot.
   */
  async runIfDue(trigger: RunTrigger = "schedule"): Promise<DueRunOutcome> {
    if (trigger !== "schedule") {
      return this.toDueOutcome(await this.run(trigger));
    }

    // A remote store can be shared by several serverless instances; take an
    // atomic lock so two of them cannot both start the same run.
    if (!isLockableStateStore(this.store)) {
      return this.runDueCheckAndRun(trigger);
    }

    const owner = `${this.now().getTime()}-${Math.random().toString(36).slice(2)}`;
    const acquired = await this.store.acquireLock(owner, RUN_LEASE_MS);
    if (!acquired) {
      this.logger.info("Scheduled run skipped: another instance holds the lock", {
        trigger,
      });
      return { ran: false, reason: "in-progress" };
    }
    try {
      return await this.runDueCheckAndRun(trigger);
    } finally {
      await this.store.releaseLock(owner).catch((error) => {
        this.logger.warn("Could not release the scheduled-search lock", {
          message: errorMessage(error),
        });
      });
    }
  }

  /** The due-ness decision and run, shared by the locked and unlocked paths. */
  private async runDueCheckAndRun(trigger: RunTrigger): Promise<DueRunOutcome> {
    const state = await this.store.get();
    if (!state.schedule.settings.enabled) {
      return { ran: false, reason: "disabled" };
    }

    await this.recoverStaleRun();

    const refreshed = await this.store.get();
    const due = parseIso(refreshed.schedule.nextRunAt);
    if (due === undefined) {
      const armed = await this.armNextRun();
      if (armed !== undefined) {
        this.logger.info("Armed the next scheduled run from an external trigger", {
          nextRunAt: armed.toISOString(),
        });
      }
      return { ran: false, reason: "not-due" };
    }
    if (refreshed.schedule.lastRun?.status === "running") {
      return { ran: false, reason: "in-progress" };
    }
    if (due.getTime() > this.now().getTime()) {
      return { ran: false, reason: "not-due" };
    }

    return this.toDueOutcome(await this.run(trigger));
  }

  private toDueOutcome(record: RunRecord): DueRunOutcome {
    if (record.status === "skipped") {
      const reason =
        record.error?.includes("disabled") === true ? "disabled" : "already-running";
      return { ran: false, reason, record };
    }
    return { ran: true, reason: "ran", record };
  }

  /** Run now, regardless of schedule state. Used by tests and manual triggers. */
  async run(trigger: RunTrigger): Promise<RunRecord> {
    if (this.running) {
      this.logger.warn("Scheduled run skipped: a run is already in progress", { trigger });
      return this.skippedRecord(trigger, "another run is already in progress");
    }

    const state = await this.store.get();
    const settings = state.schedule.settings;
    // The scheduled slot that this run belongs to. Used to de-duplicate the
    // completion notice across restarts/retries. Undefined on a fresh state.
    const slot = state.schedule.nextRunAt;
    if (trigger === "schedule" && !settings.enabled) {
      return this.skippedRecord(trigger, "scheduling is disabled");
    }

    this.running = true;
    const startedAt = this.now().toISOString();
    this.logger.info("Scheduled job search started", { trigger, at: startedAt });
    const base: RunRecord = {
      startedAt,
      trigger,
      status: "running",
      discovered: 0,
      notified: 0,
      failed: 0,
      summarised: 0,
    };
    await this.store.update((draft) => {
      draft.schedule.lastRun = base;
    });

    let discovered = 0;
    let queued = 0;
    let notified = 0;
    let failed = 0;
    let summarised = 0;

    try {
      // Deliver anything left queued by a previous run/crash before searching.
      if (!settings.alertsPaused) {
        const flush = await this.notifier.deliverPending(this.maxNotificationsPerRun);
        notified += flush.delivered;
        failed += flush.failed;
      }

      const searchOutcome = await this.runSearch(settings);
      if (!searchOutcome.ok) {
        const finished = this.finalize(base, "failed", {
          discovered,
          notified,
          failed,
          summarised,
          error: searchOutcome.message,
        });
        await this.persistRun(finished);
        this.logger.error("Scheduled job search failed", {
          trigger,
          message: searchOutcome.message,
        });
        // Truthful failure notice: never claim "no new vacancies" on a failure.
        if (trigger !== "manual" && !settings.alertsPaused) {
          await this.sendScheduledNotice("failed", slot);
        }
        return finished;
      }
      const result = searchOutcome.result;

      const newJobs = await this.notifier.selectNew(
        result.vacancies,
        this.minAlternativeScore,
      );
      discovered = newJobs.length;

      const toNotify = newJobs.slice(0, this.maxNotificationsPerRun);
      const extra = newJobs.slice(this.maxNotificationsPerRun);
      queued = toNotify.length;
      summarised = extra.length;

      // Persist discovery before sending anything: crash-safe.
      if (toNotify.length > 0) await this.notifier.enqueue(toNotify, this.chatId);
      if (extra.length > 0) await this.notifier.markSeen(extra, "summarised");

      if (!settings.alertsPaused) {
        if (toNotify.length > 0) {
          const delivery = await this.notifier.deliverPending(this.maxNotificationsPerRun);
          notified += delivery.delivered;
          failed += delivery.failed;
        }
        if (extra.length > 0) {
          await this.notifier.sendSummary(this.chatId, extra.length);
        }
      }

      // Scheduled-search completion notice. Only for automated runs, only when
      // alerts are not paused, and only when nothing was discovered/alerted this
      // run (job alerts already sent -> stay silent). Source failures make the
      // result inconclusive, so we send a distinct truthful message instead.
      if (
        trigger !== "manual" &&
        !settings.alertsPaused &&
        discovered === 0 &&
        notified === 0
      ) {
        if (result.errors.length > 0) {
          await this.sendScheduledNotice("incomplete", slot, result.errors.length);
        } else {
          await this.sendScheduledNotice("complete", slot);
        }
      }

      const finished = this.finalize(base, "success", {
        discovered,
        notified,
        failed,
        summarised,
      });
      await this.persistRun(finished);
      await this.notifier.recordHistory({
        at: finished.finishedAt ?? startedAt,
        discovered,
        queued,
        delivered: notified,
        failed,
        summarised,
      });

      this.logger.info("Scheduled job search finished", {
        trigger,
        discovered,
        queued,
        notified,
        failed,
        summarised,
        alertsPaused: settings.alertsPaused,
      });
      return finished;
    } catch (error) {
      const message = errorMessage(error);
      const finished = this.finalize(base, "failed", {
        discovered,
        notified,
        failed,
        summarised,
        error: message,
      });
      await this.persistRun(finished);
      this.logger.error("Scheduled job search failed", { trigger, message });
      return finished;
    } finally {
      this.running = false;
    }
  }

  /**
   * Run the job search, converting a thrown error into a tagged outcome so the
   * caller can distinguish a failed search from a failure elsewhere (e.g.
   * notification delivery) and report it truthfully.
   */
  private async runSearch(
    settings: ScheduleSettings,
  ): Promise<{ ok: true; result: JobSearchResult } | { ok: false; message: string }> {
    try {
      const result = await this.search({
        keywords: [...settings.keywords],
        limit: settings.limit,
        ...(settings.location === undefined ? {} : { location: settings.location }),
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  /**
   * Send the scheduled-run completion/incomplete/failure notice at most once per
   * scheduled slot. The marker is persisted before the send, so a crash between
   * the two (or a restart/retry catching up the same slot) cannot duplicate it.
   */
  private async sendScheduledNotice(
    kind: "complete" | "incomplete" | "failed",
    slot: string | undefined,
    sourceErrors = 0,
  ): Promise<void> {
    if (slot === undefined) return;

    const state = await this.store.get();
    if (state.schedule.lastCompletionNoticeSlot === slot) {
      this.logger.info("Skipping scheduled search notice; already sent for this run", {
        kind,
        slot,
      });
      return;
    }

    await this.store.update((draft) => {
      draft.schedule.lastCompletionNoticeSlot = slot;
    });

    const text =
      kind === "complete"
        ? SCHEDULED_SEARCH_COMPLETE_MESSAGE
        : kind === "incomplete"
          ? buildScheduledSearchIncompleteMessage(sourceErrors)
          : SCHEDULED_SEARCH_FAILED_MESSAGE;

    try {
      await this.notifier.sendNotice(this.chatId, text);
      this.logger.info("Sent scheduled search notice", { kind, slot });
    } catch (error) {
      // At-most-once: the marker stays, so we never risk a duplicate notice.
      this.logger.warn("Could not send scheduled search notice", {
        kind,
        slot,
        message: errorMessage(error),
      });
    }
  }

  private async onTimer(): Promise<void> {
    this.timer = undefined;
    this.logger.info("Scheduled run timer fired", { at: this.now().toISOString() });
    try {
      await this.run("schedule");
    } finally {
      await this.scheduleNext();
    }
  }

  private async scheduleNext(): Promise<void> {
    this.clearTimer();

    const state = await this.store.get();
    const settings = state.schedule.settings;

    if (!settings.enabled) {
      if (state.schedule.nextRunAt !== undefined) {
        await this.store.update((draft) => {
          delete draft.schedule.nextRunAt;
        });
      }
      return;
    }

    const next = await this.armNextRun();
    if (next === undefined) return;

    if (!this.started) {
      this.logger.info("Schedule persisted; timer not armed (scheduler not started)", {
        time: settings.time,
        timezone: settings.timeZone,
        nextRunAt: next.toISOString(),
      });
      return;
    }

    const delay = Math.max(0, next.getTime() - this.now().getTime());
    this.timer = this.timers.setTimeout(() => {
      void this.onTimer();
    }, delay);
    this.logger.info("Scheduled run timer armed", {
      time: settings.time,
      timezone: settings.timeZone,
      now: this.now().toISOString(),
      nextRunAt: next.toISOString(),
      delayMs: delay,
    });
  }

  /**
   * Compute the next run from the persisted settings and store it. Returns the
   * instant, or `undefined` when scheduling is disabled or the settings are
   * invalid (in which case the previous value is left untouched).
   */
  private async armNextRun(): Promise<Date | undefined> {
    const state = await this.store.get();
    const settings = state.schedule.settings;
    if (!settings.enabled) return undefined;

    let next: Date;
    try {
      next = nextRunAfter(settings.time, settings.timeZone, this.now());
    } catch (error) {
      this.logger.error("Cannot schedule next run: invalid schedule settings", {
        message: errorMessage(error),
      });
      return undefined;
    }

    if (state.schedule.nextRunAt !== next.toISOString()) {
      await this.store.update((draft) => {
        draft.schedule.nextRunAt = next.toISOString();
      });
    }
    return next;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async recoverInterruptedRun(): Promise<void> {
    const state = await this.store.get();
    const last = state.schedule.lastRun;
    if (last === undefined || last.status !== "running") return;
    await this.markInterrupted(last);
  }

  /**
   * Serverless variant of {@link recoverInterruptedRun}: only take over a run
   * whose lease has expired, so an instance that is still genuinely working is
   * left alone.
   */
  private async recoverStaleRun(): Promise<void> {
    const state = await this.store.get();
    const last = state.schedule.lastRun;
    if (last === undefined || last.status !== "running") return;
    const started = parseIso(last.startedAt);
    if (started === undefined) return;
    if (this.now().getTime() - started.getTime() < RUN_LEASE_MS) return;
    await this.markInterrupted(last);
  }

  private async markInterrupted(last: RunRecord): Promise<void> {
    const finished: RunRecord = {
      ...last,
      status: "failed",
      finishedAt: this.now().toISOString(),
      error: "interrupted by bot restart",
    };
    await this.store.update((draft) => {
      draft.schedule.lastRun = finished;
      draft.schedule.recentRuns.push(finished);
      if (draft.schedule.recentRuns.length > MAX_RECENT_RUNS) {
        draft.schedule.recentRuns = draft.schedule.recentRuns.slice(-MAX_RECENT_RUNS);
      }
    });
    this.logger.warn("Marked interrupted scheduled run as failed");
  }

  private async recoverPending(): Promise<void> {
    const state = await this.store.get();
    if (state.notifications.pending.length === 0) return;
    if (state.schedule.settings.alertsPaused) {
      this.logger.info("Pending notifications retained (alerts are paused)");
      return;
    }
    const result = await this.notifier.deliverPending(this.maxNotificationsPerRun);
    this.logger.info("Recovered pending notifications after restart", result);
  }

  private async persistRun(record: RunRecord): Promise<void> {
    await this.store.update((draft) => {
      draft.schedule.lastRun = record;
      draft.schedule.recentRuns.push(record);
      if (draft.schedule.recentRuns.length > MAX_RECENT_RUNS) {
        draft.schedule.recentRuns = draft.schedule.recentRuns.slice(-MAX_RECENT_RUNS);
      }

      const settings = draft.schedule.settings;
      if (settings.enabled) {
        try {
          draft.schedule.nextRunAt = nextRunAfter(
            settings.time,
            settings.timeZone,
            this.now(),
          ).toISOString();
        } catch {
          // Leave the previous value; scheduleNext will log the problem.
        }
      } else {
        delete draft.schedule.nextRunAt;
      }
    });
  }

  private finalize(
    base: RunRecord,
    status: RunRecord["status"],
    extra: Partial<RunRecord>,
  ): RunRecord {
    return {
      ...base,
      status,
      finishedAt: this.now().toISOString(),
      ...extra,
    };
  }

  private skippedRecord(trigger: RunTrigger, reason: string): RunRecord {
    return {
      startedAt: this.now().toISOString(),
      finishedAt: this.now().toISOString(),
      trigger,
      status: "skipped",
      discovered: 0,
      notified: 0,
      failed: 0,
      summarised: 0,
      error: reason,
    };
  }
}
