import "dotenv/config";
import { ConfigError, loadConfig } from "./config/env.js";
import { createBot } from "./bot/createBot.js";
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
  logger.info(`Starting Job Scout (Phase 1). Authorised user: ${config.allowedUserId}`);

  const bot = createBot(config, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}. Stopping the bot...`);
    await bot.stop();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.start({
    onStart: (botInfo) => {
      logger.info(
        `Bot @${botInfo.username} is running. Authorised user: ${config.allowedUserId}`,
      );
    },
  });
}

main().catch(reportFatal);
