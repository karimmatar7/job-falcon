import { Bot } from "grammy";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../utils/logger.js";
import { createAuthMiddleware } from "./auth.js";
import { registerHandlers } from "./handlers/index.js";

/**
 * Build the Telegram bot: authorisation middleware first, then all handlers,
 * with a catch-all error handler that logs safely.
 */
export function createBot(config: AppConfig, logger: Logger): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(createAuthMiddleware(config.allowedUserId, logger));
  registerHandlers(bot, config, logger);

  bot.catch((error) => {
    logger.error("Unhandled bot error", error.error);
  });

  return bot;
}
