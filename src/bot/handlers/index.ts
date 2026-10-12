import type { Bot } from "grammy";
import type { AppConfig } from "../../config/env.js";
import type { Logger } from "../../utils/logger.js";
import { createLogger } from "../../utils/logger.js";
import { replyForText } from "../router.js";
import type { BotServices } from "../services.js";
import { helpHandler } from "./help.js";
import { searchHandler } from "./search.js";
import { startHandler } from "./start.js";
import { createStatusHandler } from "./status.js";
import { createScheduleHandler } from "./schedule.js";
import { createPauseHandler, createResumeHandler } from "./pauseResume.js";
import { createEmptyHandler } from "./empty.js";
import { createSaveHandler, createSavedListHandler } from "./save.js";

/** Register every command handler and the plain-text fallback on the bot. */
export function registerHandlers(
  bot: Bot,
  config: AppConfig,
  logger: Logger = createLogger(),
  services?: BotServices,
): void {
  bot.command("start", startHandler);
  bot.command("help", helpHandler);
  bot.command("status", createStatusHandler(config, services));
  bot.command("search", (ctx) => searchHandler(ctx, logger, services));

  if (services !== undefined) {
    bot.command("schedule", createScheduleHandler(services));
    bot.command("pause", createPauseHandler(services));
    bot.command("resume", createResumeHandler(services));
    bot.command("save", createSaveHandler(services));
    bot.command("saved", createSavedListHandler(services));
    bot.command("empty", createEmptyHandler(services));
  }

  bot.on("message:text", async (ctx) => {
    const reply = replyForText(ctx.message.text);
    if (reply !== null) {
      await ctx.reply(reply);
    }
  });
}