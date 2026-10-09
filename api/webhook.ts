import { webhookCallback } from "grammy";
import { loadConfig } from "../src/config/env.js";
import { createBot } from "../src/bot/createBot.js";
import { createLogger } from "../src/utils/logger.js";

/**
 * Vercel Serverless Function entry point (Node.js runtime).
 *
 * Telegram delivers updates to this endpoint via webhook; the bot is never
 * started with long polling here. The module-level instance is reused across
 * warm invocations, and grammY verifies the secret token on every request.
 */
const config = loadConfig(process.env);
const logger = createLogger([config.telegramBotToken]);
const bot = createBot(config, logger);

if (!config.webhookSecret) {
  throw new Error(
    "TELEGRAM_WEBHOOK_SECRET must be set when running the bot via webhooks.",
  );
}

export default webhookCallback(bot, "https", {
  secretToken: config.webhookSecret,
});
