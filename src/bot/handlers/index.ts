import type { Bot } from "grammy";
import type { AppConfig } from "../../config/env.js";
import type { Logger } from "../../utils/logger.js";
import { createLogger } from "../../utils/logger.js";
import { replyForText } from "../router.js";
import { helpHandler } from "./help.js";
import { searchHandler } from "./search.js";
import { startHandler } from "./start.js";
import { createStatusHandler } from "./status.js";

/** Register every command handler and the plain-text fallback on the bot. */
export function registerHandlers(
  bot: Bot,
  config: AppConfig,
  logger: Logger = createLogger(),
): void {
  bot.command("start", startHandler);
  bot.command("help", helpHandler);
  bot.command("status", createStatusHandler(config));
  bot.command("search", (ctx) => searchHandler(ctx, logger));

  bot.on("message:text", async (ctx) => {
    const reply = replyForText(ctx.message.text);
    if (reply !== null) {
      await ctx.reply(reply);
    }
  });
}
