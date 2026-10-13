import { z } from "zod";
import { vacancySchema } from "../../models/vacancy.js";
import { createLogger } from "../../utils/logger.js";
import type { Logger } from "../../utils/logger.js";
import {
  quarantineFile,
  readFileIfExists,
  writeFileAtomic,
} from "../../utils/atomicFile.js";

/**
 * Durable, on-disk state for Phase 3: schedule configuration, notification
 * bookkeeping and per-chat message history. Everything lives in a single JSON
 * document so a write is one atomic file replacement, and the whole document is
 * validated on read so a corrupted file is quarantined instead of crashing the
 * bot.
 *
 * No secrets are ever stored here: the schema has no field for a bot token,
 * API key or `.env` value.
 */

export const STATE_VERSION = 1;

export const DEFAULT_SCHEDULE_TIME = "08:00";
export const DEFAULT_SCHEDULE_TIMEZONE = "Europe/London";
export const DEFAULT_SCHEDULE_KEYWORDS = ["software developer"] as const;
export const DEFAULT_SCHEDULE_LIMIT = 10;
export const DEFAULT_MAX_NOTIFICATIONS_PER_RUN = 5;

/** Bounds so a long-running bot cannot grow its state file without limit. */
export const MAX_SEEN_JOBS = 5000;
export const MAX_PENDING_NOTIFICATIONS = 100;
export const MAX_RECENT_RUNS = 10;
export const MAX_NOTIFICATION_HISTORY = 50;
export const MAX_TRACKED_MESSAGES = 200;
export const MAX_SAVED_VACANCIES = 500;
export const MAX_VACANCY_REFS = 200;

export const scheduleSettingsSchema = z.object({
  /** Automatic scheduled searches are switched on. */
  enabled: z.boolean(),
  /** Automatic alerts are temporarily silenced (searches may still run). */
  alertsPaused: z.boolean(),
  /** Local wall-clock time of the daily search, `HH:MM`. */
  time: z.string(),
  /** IANA timezone the wall-clock time is interpreted in. */
  timeZone: z.string(),
  keywords: z.array(z.string()),
  limit: z.number().int(),
  location: z.string().optional(),
});
export type ScheduleSettings = z.infer<typeof scheduleSettingsSchema>;

export const runTriggerSchema = z.enum(["schedule", "restart", "manual"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

export const runStatusSchema = z.enum(["running", "success", "failed", "skipped"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runRecordSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  trigger: runTriggerSchema,
  status: runStatusSchema,
  discovered: z.number().int(),
  notified: z.number().int(),
  failed: z.number().int(),
  summarised: z.number().int(),
  error: z.string().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const scheduleStateSchema = z.object({
  settings: scheduleSettingsSchema,
  nextRunAt: z.string().optional(),
  lastRun: runRecordSchema.optional(),
  recentRuns: z.array(runRecordSchema),
  /**
   * The scheduled slot (its `nextRunAt`) for which the "search complete" notice
   * was last sent. Persisted before sending so a crash/restart/retry cannot
   * deliver the same completion message twice for one scheduled run.
   */
  lastCompletionNoticeSlot: z.string().optional(),
});
export type ScheduleState = z.infer<typeof scheduleStateSchema>;

export const seenJobStatusSchema = z.enum(["seen", "notified", "summarised", "dropped"]);
export type SeenJobStatus = z.infer<typeof seenJobStatusSchema>;

export const seenJobSchema = z.object({
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  notifiedAt: z.string().optional(),
  status: seenJobStatusSchema,
});
export type SeenJob = z.infer<typeof seenJobSchema>;

export const pendingNotificationSchema = z.object({
  /** Primary identity key for the job. */
  key: z.string(),
  /** Every identity key that maps to this job (url, id, employer+title+location). */
  keys: z.array(z.string()),
  chatId: z.number().int(),
  vacancy: vacancySchema,
  attempts: z.number().int(),
  createdAt: z.string(),
  lastAttemptAt: z.string().optional(),
  lastError: z.string().optional(),
});
export type PendingNotification = z.infer<typeof pendingNotificationSchema>;

export const notificationHistoryEntrySchema = z.object({
  at: z.string(),
  discovered: z.number().int(),
  queued: z.number().int(),
  delivered: z.number().int(),
  failed: z.number().int(),
  summarised: z.number().int(),
});
export type NotificationHistoryEntry = z.infer<typeof notificationHistoryEntrySchema>;

export const notificationStateSchema = z.object({
  /** Every identity key ever seen, so a listing is only ever alerted once. */
  seen: z.record(z.string(), seenJobSchema),
  pending: z.array(pendingNotificationSchema),
  history: z.array(notificationHistoryEntrySchema),
});
export type NotificationState = z.infer<typeof notificationStateSchema>;

export const trackedMessageSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  direction: z.enum(["bot", "user"]),
});
export type TrackedMessage = z.infer<typeof trackedMessageSchema>;

export const conversationStateSchema = z.object({
  messages: z.array(trackedMessageSchema),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export const conversationsStateSchema = z.object({
  byChat: z.record(z.string(), conversationStateSchema),
});
export type ConversationsState = z.infer<typeof conversationsStateSchema>;

/**
 * A vacancy the user explicitly saved with `/save`. These records - and the
 * original Telegram message they came from - must survive `/empty`. They live
 * outside `conversations` on purpose so chat cleanup can never touch them.
 */
export const savedVacancySchema = z.object({
  /** Stable, human-facing id shown by `/saved` and `/save` confirmations. */
  id: z.number().int(),
  chatId: z.number().int(),
  /** Primary cross-source identity key (see jobIdentity.ts). */
  key: z.string(),
  /** Every identity key that maps to this vacancy. */
  keys: z.array(z.string()),
  vacancy: vacancySchema,
  savedAt: z.string(),
  /** The Telegram message carrying this vacancy, when it was known. */
  messageId: z.number().int().optional(),
});
export type SavedVacancy = z.infer<typeof savedVacancySchema>;

export const savedVacanciesSchema = z
  .object({
    entries: z.array(savedVacancySchema),
    nextId: z.number().int(),
  })
  .default({ entries: [], nextId: 1 });
export type SavedVacancies = z.infer<typeof savedVacanciesSchema>;

/**
 * A recently delivered message that carried one or more vacancies, so `/save`
 * can turn "the vacancy I just received" into a saved record. Purely an index
 * for `/save`; storing it is not required for deletion.
 */
export const vacancyRefSchema = z.object({
  chatId: z.number().int(),
  messageId: z.number().int(),
  at: z.string(),
  vacancy: vacancySchema,
});
export type VacancyRef = z.infer<typeof vacancyRefSchema>;

export const vacancyIndexSchema = z
  .object({ items: z.array(vacancyRefSchema) })
  .default({ items: [] });
export type VacancyIndex = z.infer<typeof vacancyIndexSchema>;

export const persistedStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  schedule: scheduleStateSchema,
  notifications: notificationStateSchema,
  conversations: conversationsStateSchema,
  // Added after v1 shipped; defaults keep older state files loadable as-is.
  savedVacancies: savedVacanciesSchema,
  vacancyIndex: vacancyIndexSchema,
});
export type PersistedState = z.infer<typeof persistedStateSchema>;

export interface InitialStateOptions {
  readonly scheduleEnabled?: boolean;
  readonly scheduleTime?: string;
  readonly scheduleTimeZone?: string;
  readonly scheduleKeywords?: readonly string[];
  readonly scheduleLimit?: number;
  readonly scheduleLocation?: string;
}

/** Build a fully-populated default state document. */
export function createInitialState(options: InitialStateOptions = {}): PersistedState {
  return {
    version: STATE_VERSION,
    schedule: {
      settings: {
        enabled: options.scheduleEnabled ?? true,
        alertsPaused: false,
        time: options.scheduleTime ?? DEFAULT_SCHEDULE_TIME,
        timeZone: options.scheduleTimeZone ?? DEFAULT_SCHEDULE_TIMEZONE,
        keywords: [...(options.scheduleKeywords ?? DEFAULT_SCHEDULE_KEYWORDS)],
        limit: options.scheduleLimit ?? DEFAULT_SCHEDULE_LIMIT,
        ...(options.scheduleLocation === undefined
          ? {}
          : { location: options.scheduleLocation }),
      },
      recentRuns: [],
    },
    notifications: { seen: {}, pending: [], history: [] },
    conversations: { byChat: {} },
    savedVacancies: { entries: [], nextId: 1 },
    vacancyIndex: { items: [] },
  };
}

/**
 * Minimal persistence contract. Implementations must:
 * - return immutable snapshots (callers may not mutate shared state), and
 * - serialise updates so concurrent writes cannot interleave.
 */
export interface StateStore {
  get(): Promise<PersistedState>;
  update(mutator: (draft: PersistedState) => void): Promise<PersistedState>;
}

/**
 * A store that can grant an atomic, time-limited lock. Only remote stores that
 * may be shared by several processes (for example Upstash Redis) need this;
 * file/in-memory stores are single-process and serialise their own updates.
 *
 * The lock exists to make `Scheduler.runIfDue` safe against overlapping
 * serverless invocations: without it two cold instances could both decide a run
 * is due and deliver the same alerts.
 */
export interface LockableStateStore extends StateStore {
  /** Acquire the lock for `owner` if free, for at most `ttlMs`; false if held. */
  acquireLock(owner: string, ttlMs: number): Promise<boolean>;
  /** Release the lock only if `owner` still holds it. */
  releaseLock(owner: string): Promise<void>;
}

/** Narrow a {@link StateStore} to a {@link LockableStateStore} when supported. */
export function isLockableStateStore(store: StateStore): store is LockableStateStore {
  const candidate = store as Partial<LockableStateStore>;
  return (
    typeof candidate.acquireLock === "function" &&
    typeof candidate.releaseLock === "function"
  );
}

function cloneState(state: PersistedState): PersistedState {
  return structuredClone(state);
}

export interface FileStateStoreOptions {
  readonly filePath: string;
  readonly logger?: Logger;
  readonly initial?: PersistedState;
}

/**
 * File-backed store. Reads once, then keeps the document in memory and writes
 * it back atomically after each update. Updates are queued so two callers can
 * never write over each other.
 */
export class FileStateStore implements StateStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly initial: PersistedState;
  private state: PersistedState | undefined;
  private loadPromise: Promise<PersistedState> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileStateStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger ?? createLogger();
    this.initial = options.initial ?? createInitialState();
  }

  async get(): Promise<PersistedState> {
    if (this.state !== undefined) return cloneState(this.state);
    this.loadPromise ??= this.load();
    return cloneState(await this.loadPromise);
  }

  update(mutator: (draft: PersistedState) => void): Promise<PersistedState> {
    const run = this.queue.then(async () => {
      const current = await this.get();
      mutator(current);
      const validated = persistedStateSchema.parse(current);
      await writeFileAtomic(this.filePath, `${JSON.stringify(validated, null, 2)}\n`);
      this.state = validated;
      return cloneState(validated);
    });
    // Keep the queue alive even when an update rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<PersistedState> {
    const text = await readFileIfExists(this.filePath);
    if (text === undefined) {
      this.state = this.initial;
      return this.state;
    }

    try {
      const parsed = persistedStateSchema.parse(JSON.parse(text) as unknown);
      this.state = parsed;
      return parsed;
    } catch {
      const backup = await quarantineFile(this.filePath).catch(() => undefined);
      this.logger.warn("State file was unreadable; starting from defaults", {
        file: this.filePath,
        ...(backup === undefined ? {} : { backup }),
      });
      this.state = this.initial;
      return this.state;
    }
  }
}

/** In-memory store used by tests and by environments without a writable disk. */
export class InMemoryStateStore implements StateStore {
  private state: PersistedState;

  constructor(initial: PersistedState = createInitialState()) {
    this.state = initial;
  }

  async get(): Promise<PersistedState> {
    return cloneState(this.state);
  }

  async update(mutator: (draft: PersistedState) => void): Promise<PersistedState> {
    const draft = cloneState(this.state);
    mutator(draft);
    this.state = persistedStateSchema.parse(draft);
    return cloneState(this.state);
  }
}
