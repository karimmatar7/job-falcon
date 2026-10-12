import type { Context } from "grammy";
import type { BotServices } from "../services.js";
import {
  clearConversation,
  isAgeRelatedDeleteError,
} from "../../services/conversation/clearConversation.js";
import {
  buildEmptyNoHistoryMessage,
  buildEmptySummary,
} from "../../messages.js";

/**
 * `/empty` — clear this chat of messages the bot is allowed to delete, while
 * keeping every vacancy the user explicitly saved with `/save`.
 *
 * Telegram's API has no "clear chat history" call: a bot can only delete
 * messages it knows the id of, and only ones younger than 48 hours. This handler
 * deletes every tracked message in this exact chat (the authorised user's
 * private chat), skips saved-vacancy messages and anything older than the
 * window without pretending, reports the truth about failures, and offers
 * Telegram's own Clear history as the fallback. No persistent application data
 * (schedule, seen jobs, notification queue, saved vacancies) is touched.
 */
export function createEmptyHandler(services: BotServices) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      await ctx.reply("I could not determine this chat, so nothing was deleted.");
      return;
    }

    const messages = await services.tracker.getMessages(chatId);
    const saved = await services.savedVacancies.listSaved(chatId);
    const savedIds = await services.savedVacancies.savedMessageIds(chatId);

    // Saved-vacancy messages are never attempted, at any age.
    const deletable = messages.filter((message) => !savedIds.has(message.id));

    if (messages.length === 0) {
      await ctx.reply(buildEmptyNoHistoryMessage(savedIds.size, saved.length));
      return;
    }

    const result = await clearConversation({
      chatId,
      messages: deletable,
      deleteMessage: async (messageChatId, messageId) => {
        await ctx.api.deleteMessage(messageChatId, messageId);
      },
    });

    // Remove only the ids we processed. The confirmation below is sent after
    // this, so it is never deleted. Saved-vacancy message ids are also dropped
    // from tracking, but they stay protected by the saved records, not tracking.
    await services.tracker.clearMessages(chatId);
    // Drop /save index entries that now point at deleted messages; the saved
    // (protected) messages remain resolvable.
    await services.savedVacancies.pruneRefs(chatId, savedIds);

    const ageRelated = result.failures.filter((failure) =>
      isAgeRelatedDeleteError(failure.reason),
    ).length;

    await ctx.reply(
      buildEmptySummary({
        deleted: result.deleted,
        failed: result.failed,
        failedAgeRelated: ageRelated,
        skippedOld: result.skippedOld,
        preservedMessages: savedIds.size,
        preservedRecords: saved.length,
      }),
    );
  };
}
