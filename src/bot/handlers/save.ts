import type { Context } from "grammy";
import type { BotServices } from "../services.js";
import { parseCommand } from "../command.js";
import {
  SAVE_NO_RECENT_MESSAGE,
  SAVED_EMPTY_MESSAGE,
  SAVE_USAGE_MESSAGE,
  buildAlreadySavedMessage,
  buildSaveConfirmationMessage,
  buildSaveInvalidSelectionMessage,
  buildSaveSelectionMessage,
  buildSavedListMessage,
} from "../../messages.js";

/**
 * `/save [number]` — persist the vacancy from the most recently delivered
 * vacancy message (or from the message this command replies to), and protect
 * that Telegram message from `/empty`.
 *
 * The saved record itself lives outside the chat history, so running `/empty`
 * can never lose it even if the original message ages out of Telegram's
 * deletion window.
 */
export function createSaveHandler(services: BotServices) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      await ctx.reply("I could not determine this chat, so nothing was saved.");
      return;
    }

    const args = parseCommand(ctx.message?.text)?.args ?? [];
    let index: number | undefined;
    if (args.length > 0) {
      const parsed = Number(args[0]);
      if (!Number.isInteger(parsed) || parsed < 1) {
        await ctx.reply(SAVE_USAGE_MESSAGE);
        return;
      }
      index = parsed;
    }

    const replyToMessageId = ctx.message?.reply_to_message?.message_id;

    const outcome = await services.savedVacancies.save(chatId, {
      ...(index === undefined ? {} : { index }),
      ...(typeof replyToMessageId !== "number" ? {} : { replyToMessageId }),
    });

    switch (outcome.status) {
      case "saved":
        await ctx.reply(buildSaveConfirmationMessage(outcome.entry));
        return;
      case "already_saved":
        await ctx.reply(buildAlreadySavedMessage(outcome.entry));
        return;
      case "no_recent_vacancy":
        await ctx.reply(SAVE_NO_RECENT_MESSAGE);
        return;
      case "selection_required":
        await ctx.reply(buildSaveSelectionMessage(outcome.vacancies));
        return;
      case "invalid_selection":
        await ctx.reply(buildSaveInvalidSelectionMessage(outcome.count));
        return;
    }
  };
}

/** `/saved` — list the vacancies the user has explicitly saved. */
export function createSavedListHandler(services: BotServices) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      await ctx.reply("I could not determine this chat.");
      return;
    }

    const entries = await services.savedVacancies.listSaved(chatId);
    await ctx.reply(
      entries.length === 0 ? SAVED_EMPTY_MESSAGE : buildSavedListMessage(entries),
    );
  };
}
