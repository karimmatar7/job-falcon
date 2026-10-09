import { webhookCallback } from "grammy";
import type { Bot } from "grammy";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../utils/logger.js";
import { createBot } from "./createBot.js";

/**
 * Build the HTTPS webhook handler used by the Vercel function in `api/`.
 *
 * A secret token is mandatory in webhook mode. grammY compares it against the
 * `X-Telegram-Bot-Api-Secret-Token` header using a constant-time comparison and
 * answers mismatches with HTTP 401. Creating the handler on a bot instance also
 * disables long polling for that instance (grammY throws if it is already
 * polling and overrides `bot.start`), so polling and webhooks never run at the
 * same time.
 */
export function createWebhookHandler(
  config: AppConfig,
  logger: Logger,
  bot: Bot = createBot(config, logger),
) {
  if (!config.webhookSecret) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be set when running the bot via webhooks.",
    );
  }

  return webhookCallback(bot, "https", { secretToken: config.webhookSecret });
}
