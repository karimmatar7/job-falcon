import "dotenv/config";
import { ConfigError, loadConfig } from "./config/env.js";
import { createBotApp } from "./bot/createBot.js";
import { createLogger, redactSecrets } from "./utils/logger.js";

function reportFatal(error: unknown): void {
  const secrets = [process.env.TELEGRAM_BOT_TOKEN, process.env.BOT_TOKEN].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(
    "Fatal error while starting the bot:",
    redactSecrets(message, secrets),
  );
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error("");
      console.error("Copy .env.example to .env and fill in the values, then try again.");
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger([config.telegramBotToken]);
  logger.info(`Starting JobFalcon (Phase 3). Authorised user: ${config.allowedUserId}`);
  logger.info('Sponsor register configured', {
    configured: config.sponsorRegisterUrl !== undefined,
  });

  const { bot, services } = createBotApp(config, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}. Stopping the bot...`);
    services.scheduler.stop();
    await bot.stop();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Start the scheduler BEFORE the polling loop: grammY's bot.start() blocks
  // in long polling until the bot is stopped, so anything awaited after it
  // (like a timer arm) would never run while the bot is alive. Safe to fail
  // the process if the scheduler cannot start: better to surface a broken
  // schedule than to run silently without alerts.
  await services.scheduler.start();

  await bot.start({
    onStart: (botInfo) => {
      logger.info(
        `Bot @${botInfo.username} is running. Authorised user: ${config.allowedUserId}`,
      );
    },
  });
}

main().catch(reportFatal);