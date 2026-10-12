import type { Logger } from "../../utils/logger.js";
import type { TrackedMessage } from "../state/stateStore.js";

/**
 * Telegram refuses to delete a message that is more than 48 hours old. The bot
 * therefore never even attempts older messages and reports them as "left in
 * place" instead of pretending they were removed.
 */
export const TELEGRAM_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

export type DeleteMessageFn = (chatId: number, messageId: number) => Promise<void>;

export interface ClearConversationResult {
  /** Messages recent enough to be eligible for deletion. */
  readonly attempted: number;
  readonly deleted: number;
  readonly failed: number;
  /** Messages older than the 48-hour window, left untouched. */
  readonly skippedOld: number;
  /** Reasons for failures, for a truthful reply (never includes message text). */
  readonly failures: readonly { messageId: number; reason: string }[];
}

/** A Telegram description that means "the 48-hour window has elapsed". */
export function isAgeRelatedDeleteError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("too old") ||
    text.includes("can't be deleted") ||
    text.includes("cannot be deleted") ||
    text.includes("message to delete not found") ||
    text.includes("message can't be deleted")
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Delete the tracked messages of one conversation, honouring Telegram's real
 * limits. Only ids that were recorded for this exact chat are attempted, so the
 * bot never touches another chat's messages. Persistent application data is
 * never part of `messages` and is therefore untouched.
 */
export async function clearConversation(params: {
  readonly chatId: number;
  readonly messages: readonly TrackedMessage[];
  readonly deleteMessage: DeleteMessageFn;
  readonly now?: () => Date;
  readonly retentionMs?: number;
  readonly onDelete?: (message: TrackedMessage) => Promise<void> | void;
  readonly logger?: Logger;
}): Promise<ClearConversationResult> {
  const now = params.now ?? (() => new Date());
  const retentionMs = params.retentionMs ?? TELEGRAM_DELETE_WINDOW_MS;
  const cutoff = now().getTime() - retentionMs;

  let attempted = 0;
  let deleted = 0;
  let skippedOld = 0;
  const failures: { messageId: number; reason: string }[] = [];

  for (const message of params.messages) {
    const sentAt = Date.parse(message.at);
    if (!Number.isNaN(sentAt) && sentAt < cutoff) {
      skippedOld++;
      continue;
    }

    attempted++;
    try {
      await params.deleteMessage(params.chatId, message.id);
      deleted++;
    } catch (error) {
      const reason = reasonOf(error);
      failures.push({ messageId: message.id, reason });
      params.logger?.warn("Could not delete a chat message", {
        chatId: params.chatId,
        messageId: message.id,
        ageRelated: isAgeRelatedDeleteError(reason),
      });
      continue;
    }

    try {
      await params.onDelete?.(message);
    } catch (error) {
      params.logger?.warn("Deleted a message but could not update the message history", {
        chatId: params.chatId,
        messageId: message.id,
        message: reasonOf(error),
      });
    }
  }

  return {
    attempted,
    deleted,
    failed: failures.length,
    skippedOld,
    failures,
  };
}
