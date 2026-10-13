import { loadConfig } from "../src/config/env.js";
import { resolveCronSecret } from "../src/config/cron.js";
import { createBotApp } from "../src/bot/createBot.js";
import { createLogger } from "../src/utils/logger.js";
import { createScheduledSearchEndpoint } from "../src/bot/scheduledSearchEndpoint.js";

/**
 * Vercel Serverless Function entry point for scheduled searches.
 *
 * Telegram user updates arrive at `/api/webhook`; this separate endpoint is
 * invoked by Vercel Cron (or any external scheduler) and runs the daily search
 * when it is actually due. It never starts long polling, so it cannot compete
 * with the webhook, and it shares the same bot services (state, scheduler,
 * notifier) as the webhook.
 *
 * Security: the request must carry `Authorization: Bearer ${CRON_SECRET}`
 * (Vercel sends this automatically when `CRON_SECRET` is set). The secret is
 * compared in constant time and is never logged or placed in a URL.
 *
 * The module-level instance is reused across warm invocations; construction
 * performs no network calls and does not start the bot.
 */
const config = loadConfig(process.env);
const logger = createLogger([config.telegramBotToken]);
const { services } = createBotApp(config, logger);

const cronSecret = config.cronSecret ?? resolveCronSecret(process.env);
if (cronSecret === undefined) {
  throw new Error(
    "CRON_SECRET must be set when invoking the scheduled-search endpoint.",
  );
}

export default createScheduledSearchEndpoint({
  scheduler: services.scheduler,
  logger,
  secret: cronSecret,
});
