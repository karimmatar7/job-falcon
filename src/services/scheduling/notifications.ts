import type { Vacancy } from "../../models/vacancy.js";
import type { Logger } from "../../utils/logger.js";
import { groupFor, formatVacancy } from "../../bot/vacancyCard.js";
import {
  MAX_NOTIFICATION_HISTORY,
  MAX_PENDING_NOTIFICATIONS,
  MAX_SEEN_JOBS,
} from "../state/stateStore.js";
import type {
  NotificationHistoryEntry,
  PersistedState,
  SeenJobStatus,
  StateStore,
} from "../state/stateStore.js";
import { identityKey, jobIdentityKeys } from "./jobIdentity.js";

/**
 * Sends a notification and resolves with the Telegram message id. Kept as a
 * narrow function so unit tests can substitute a fake with no network access.
 * `parseMode` is optional so plain-text summaries are never parsed as markup.
 */
export type NotificationSender = (params: {
  readonly chatId: number;
  readonly text: string;
  readonly parseMode?: "MarkdownV2";
}) => Promise<number>;

export interface NotifierOptions {
  readonly store: StateStore;
  readonly sender: NotificationSender;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly maxAttempts?: number;
  /**
   * Called after a vacancy message is successfully sent, with its Telegram
   * message id, so `/save` can resolve the vacancy. Failures here are logged and
   * never break delivery.
   */
  readonly onDelivered?: (info: {
    readonly chatId: number;
    readonly messageId: number;
    readonly vacancies: readonly Vacancy[];
  }) => Promise<void> | void;
}

export interface EnqueueResult {
  readonly queued: number;
  readonly seenKeys: number;
}

export interface DeliveryResult {
  readonly delivered: number;
  readonly failed: number;
  readonly dropped: number;
  readonly remaining: number;
}

export const DEFAULT_MAX_SEND_ATTEMPTS = 5;

/** Errors Telegram will never recover from: retrying just wastes calls. */
export function isPermanentSendError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("chat not found") ||
    text.includes("bot was blocked") ||
    text.includes("user is deactivated") ||
    text.includes("bot can't initiate conversation") ||
    text.includes("bot cannot initiate conversation") ||
    text.includes("can't parse entities") ||
    text.includes("cannot parse entities") ||
    text.includes("message text is empty")
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Owns everything about "which jobs have we already seen" and "which
 * notifications still need to go out". Both are persisted before any message is
 * sent, so a crash between discovery and delivery cannot lose a notification:
 * the durable pending entry is retried on the next run.
 */
export class Notifier {
  private readonly store: StateStore;
  private readonly sender: NotificationSender;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly onDelivered: NotifierOptions["onDelivered"];

  constructor(options: NotifierOptions) {
    this.store = options.store;
    this.sender = options.sender;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_SEND_ATTEMPTS;
    this.onDelivered = options.onDelivered;
  }

  /** New, notification-eligible vacancies, strongest evidence and score first. */
  async selectNew(
    vacancies: readonly Vacancy[],
    minAlternativeScore: number,
  ): Promise<Vacancy[]> {
    const state = await this.store.get();
    const seen = state.notifications.seen;

    const candidates = vacancies.filter((vacancy) => {
      if (vacancy.vacancySponsorshipStatus === "not_offered") return false;
      if (vacancy.vacancySponsorshipStatus !== "confirmed") {
        if (vacancy.locationEligibility === "ineligible") return false;
        if ((vacancy.matchScore ?? 0) < minAlternativeScore) return false;
      }
      return jobIdentityKeys(vacancy).every((key) => seen[key] === undefined);
    });

    return candidates.sort((a, b) => {
      const aConfirmed = a.vacancySponsorshipStatus === "confirmed" ? 1 : 0;
      const bConfirmed = b.vacancySponsorshipStatus === "confirmed" ? 1 : 0;
      if (aConfirmed !== bConfirmed) return bConfirmed - aConfirmed;
      return (b.matchScore ?? 0) - (a.matchScore ?? 0);
    });
  }

  /**
   * Mark jobs as seen and queue the ones that should be delivered. Persisted in
   * a single atomic update before any message is sent.
   */
  async enqueue(vacancies: readonly Vacancy[], chatId: number): Promise<EnqueueResult> {
    if (vacancies.length === 0) return { queued: 0, seenKeys: 0 };
    const nowIso = this.now().toISOString();
    let seenKeys = 0;

    await this.store.update((draft) => {
      for (const vacancy of vacancies) {
        const keys = jobIdentityKeys(vacancy);
        for (const key of keys) {
          const existing = draft.notifications.seen[key];
          if (existing !== undefined) existing.lastSeenAt = nowIso;
          else draft.notifications.seen[key] = {
            firstSeenAt: nowIso,
            lastSeenAt: nowIso,
            status: "seen",
          };
        }
        seenKeys += keys.length;
        draft.notifications.pending.push({
          key: identityKey(vacancy),
          keys,
          chatId,
          vacancy,
          attempts: 0,
          createdAt: nowIso,
        });
      }
      this.prune(draft);
    });

    return { queued: vacancies.length, seenKeys };
  }

  /** Mark jobs as seen without queueing them (e.g. matches beyond the per-run cap). */
  async markSeen(vacancies: readonly Vacancy[], status: SeenJobStatus = "summarised"): Promise<void> {
    if (vacancies.length === 0) return;
    const nowIso = this.now().toISOString();
    await this.store.update((draft) => {
      for (const vacancy of vacancies) {
        for (const key of jobIdentityKeys(vacancy)) {
          const existing = draft.notifications.seen[key];
          if (existing !== undefined) {
            existing.lastSeenAt = nowIso;
            existing.status = status;
          } else {
            draft.notifications.seen[key] = {
              firstSeenAt: nowIso,
              lastSeenAt: nowIso,
              status,
            };
          }
        }
      }
      this.prune(draft);
    });
  }

  /**
   * Attempt delivery of queued notifications, oldest first, up to `limit`.
   * A failed send is never marked delivered: it stays pending (with the error
   * recorded) unless the failure is permanent or the attempt budget is spent.
   */
  async deliverPending(limit: number): Promise<DeliveryResult> {
    const state = await this.store.get();
    const batch = state.notifications.pending.slice(0, Math.max(0, limit));
    let delivered = 0;
    let failed = 0;
    let dropped = 0;

    for (const item of batch) {
      const text = this.buildMessage(item.vacancy);
      try {
        const messageId = await this.sender({
          chatId: item.chatId,
          text,
          parseMode: "MarkdownV2",
        });
        await this.store.update((draft) => {
          draft.notifications.pending = draft.notifications.pending.filter(
            (entry) => entry.key !== item.key,
          );
          this.markKeysNotified(draft, item.keys, this.now().toISOString());
        });
        await this.recordDelivered(item.chatId, messageId, item.vacancy);
        delivered++;
      } catch (error) {
        const reason = errorMessage(error);
        const permanent =
          isPermanentSendError(reason) || item.attempts + 1 >= this.maxAttempts;
        if (permanent) dropped++;
        else failed++;

        this.logger.warn("Notification delivery failed", {
          key: item.key,
          attempts: item.attempts + 1,
          permanent,
          reason,
        });

        await this.store.update((draft) => {
          if (permanent) {
            draft.notifications.pending = draft.notifications.pending.filter(
              (entry) => entry.key !== item.key,
            );
            for (const key of item.keys) {
              const seen = draft.notifications.seen[key];
              if (seen !== undefined) seen.status = "dropped";
            }
            return;
          }
          const pending = draft.notifications.pending.find(
            (entry) => entry.key === item.key,
          );
          if (pending !== undefined) {
            pending.attempts += 1;
            pending.lastAttemptAt = this.now().toISOString();
            pending.lastError = reason;
          }
        });
      }
    }

    const after = await this.store.get();
    return {
      delivered,
      failed,
      dropped,
      remaining: after.notifications.pending.length,
    };
  }

  private async recordDelivered(
    chatId: number,
    messageId: number,
    vacancy: Vacancy,
  ): Promise<void> {
    if (this.onDelivered === undefined) return;
    try {
      await this.onDelivered({ chatId, messageId, vacancies: [vacancy] });
    } catch (error) {
      this.logger.warn("Could not index a delivered vacancy message", {
        chatId,
        messageId,
        message: errorMessage(error),
      });
    }
  }

  async sendSummary(chatId: number, count: number): Promise<void> {
    if (count <= 0) return;
    const text = [
      `\u{1F514} ${count} more new match(es) were found but not sent individually,`,
      "to avoid flooding this chat. Run /search to inspect them.",
    ].join("\n");
    await this.sender({ chatId, text });
  }

  /**
   * Send a plain-text informational message (not a job card). Used for the
   * scheduled-search completion notices. Goes through the same sender as alerts,
   * so it is tracked and can be cleared with /empty.
   */
  async sendNotice(chatId: number, text: string): Promise<void> {
    await this.sender({ chatId, text });
  }

  async recordHistory(entry: NotificationHistoryEntry): Promise<void> {
    await this.store.update((draft) => {
      draft.notifications.history.push(entry);
      if (draft.notifications.history.length > MAX_NOTIFICATION_HISTORY) {
        draft.notifications.history = draft.notifications.history.slice(
          -MAX_NOTIFICATION_HISTORY,
        );
      }
    });
  }

  buildMessage(vacancy: Vacancy): string {
    const group = groupFor(vacancy);
    const header =
      group === "confirmed"
        ? "\u{1F514} *New job with CONFIRMED sponsorship*"
        : "\u{1F514} *New relevant job \\(sponsorship unconfirmed\\)*";
    return `${header}\n\n${formatVacancy(vacancy, group)}`;
  }

  private markKeysNotified(
    draft: PersistedState,
    keys: readonly string[],
    nowIso: string,
  ): void {
    for (const key of keys) {
      const seen = draft.notifications.seen[key];
      if (seen !== undefined) {
        seen.notifiedAt = nowIso;
        seen.status = "notified";
      } else {
        draft.notifications.seen[key] = {
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          notifiedAt: nowIso,
          status: "notified",
        };
      }
    }
  }

  /** Keep the state document bounded without losing recent history. */
  private prune(draft: PersistedState): void {
    const seenEntries = Object.entries(draft.notifications.seen);
    if (seenEntries.length > MAX_SEEN_JOBS) {
      seenEntries.sort((a, b) => a[1].lastSeenAt.localeCompare(b[1].lastSeenAt));
      const excess = seenEntries.length - MAX_SEEN_JOBS;
      for (let index = 0; index < excess; index++) {
        const entry = seenEntries[index];
        if (entry !== undefined) delete draft.notifications.seen[entry[0]];
      }
    }

    if (draft.notifications.pending.length > MAX_PENDING_NOTIFICATIONS) {
      const overflow = draft.notifications.pending.length - MAX_PENDING_NOTIFICATIONS;
      const removed = draft.notifications.pending.slice(0, overflow);
      draft.notifications.pending = draft.notifications.pending.slice(overflow);
      for (const item of removed) {
        for (const key of item.keys) {
          const seen = draft.notifications.seen[key];
          if (seen !== undefined) seen.status = "dropped";
        }
      }
      this.logger.warn("Dropped oldest pending notifications to bound state size", {
        dropped: removed.length,
      });
    }
  }
}
