import { Bot } from "grammy";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../utils/logger.js";
import {
  FileStateStore,
  InMemoryStateStore,
  createInitialState,
} from "../services/state/stateStore.js";
import type { PersistedState, StateStore } from "../services/state/stateStore.js";
import { UpstashStateStore } from "../services/state/upstashStateStore.js";
import { resolveStateBackend } from "../services/state/stateBackend.js";
import { MessageTracker } from "../services/conversation/messageTracker.js";
import { SavedVacancyService } from "../services/savedVacancies.js";
import { Notifier } from "../services/scheduling/notifications.js";
import type { NotificationSender } from "../services/scheduling/notifications.js";
import { Scheduler } from "../services/scheduling/scheduler.js";
import type { SchedulerTimers } from "../services/scheduling/scheduler.js";
import { createScheduledSearch } from "../services/scheduling/searchRunner.js";
import type { JobSearchFn } from "../services/scheduling/searchRunner.js";
import { createDefaultSponsorRegister } from "../services/sponsorRegister.js";
import { createAuthMiddleware } from "./auth.js";
import { registerHandlers } from "./handlers/index.js";
import type { BotServices } from "./services.js";

/** Everything constructed for one bot instance. */
export interface BotApp {
  readonly bot: Bot;
  readonly services: BotServices;
}

export interface CreateBotOptions {
  /** Replace the default state store (tests use in-memory stores). */
  readonly store?: StateStore;
  /**
   * When `false`, use an in-memory store instead of the file store. Suitable
   * for serverless invocations where no durable disk exists.
   */
  readonly persistent?: boolean;
  /** Explicit path for the state file. */
  readonly stateFilePath?: string;
  readonly initial?: PersistedState;
  readonly now?: () => Date;
  readonly timers?: SchedulerTimers;
  readonly search?: JobSearchFn;
  readonly sender?: NotificationSender;
}

/** Extract `chat_id` from a Bot API payload when present. */
function readChatId(payload: unknown): number | undefined {
  const record = payload as { chat_id?: unknown };
  return typeof record.chat_id === "number" ? record.chat_id : undefined;
}

/** Extract `message_id` from a successful Bot API response when present. */
function readMessageId(result: unknown): number | undefined {
  const record = result as { ok?: unknown; result?: unknown };
  if (record.ok !== true) return undefined;
  const inner = record.result as { message_id?: unknown };
  return typeof inner.message_id === "number" ? inner.message_id : undefined;
}

function defaultStateDirectory(config: AppConfig): string {
  const configured = config.stateDir?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env.VERCEL !== undefined) return os.tmpdir();
  return path.join(process.cwd(), "data");
}

function buildStateStore(
  config: AppConfig,
  options: CreateBotOptions,
  logger: Logger,
): StateStore {
  if (options.store !== undefined) return options.store;

  const initialOptions = {
    ...(config.scheduleTime === undefined ? {} : { scheduleTime: config.scheduleTime }),
    ...(config.scheduleTimeZone === undefined
      ? {}
      : { scheduleTimeZone: config.scheduleTimeZone }),
    ...(config.scheduleEnabled === undefined
      ? {}
      : { scheduleEnabled: config.scheduleEnabled }),
  };
  const initial = options.initial ?? createInitialState(initialOptions);

  if (options.persistent === false) return new InMemoryStateStore(initial);

  if (options.stateFilePath !== undefined) {
    return new FileStateStore({ filePath: options.stateFilePath, logger, initial });
  }

  const backend = resolveStateBackend(process.env);
  if (backend.kind === "memory") return new InMemoryStateStore(initial);
  if (backend.kind === "upstash") {
    logger.info("Using durable Upstash state store", { key: backend.key });
    return new UpstashStateStore({
      url: backend.url,
      token: backend.token,
      key: backend.key,
      logger,
      initial,
    });
  }

  return new FileStateStore({
    filePath: path.join(defaultStateDirectory(config), "job-scout-state.json"),
    logger,
    initial,
  });
}

/**
 * Build a complete bot application: state store, message history tracking
 * (outgoing via an API transformer, incoming via middleware), the scheduler and
 * the notifier, then every command handler behind the authorisation wall.
 *
 * The outgoing transformer records every message the bot sends to the
 * authorised user so `/empty` can delete them later. Tracking failures are
 * logged but never allowed to break the underlying API call.
 */
export function createBotApp(
  config: AppConfig,
  logger: Logger,
  options: CreateBotOptions = {},
): BotApp {
  const store = buildStateStore(config, options, logger);
  const tracker = new MessageTracker(store, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const bot = new Bot(config.telegramBotToken);

  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    try {
      const chatId = readChatId(payload as unknown);
      const messageId = readMessageId(result as unknown);
      if (chatId === config.allowedUserId && messageId !== undefined) {
        await tracker.recordBotMessage(chatId, messageId);
      }
    } catch (error) {
      logger.warn("Could not track an outgoing message", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  });

  bot.use(createAuthMiddleware(config.allowedUserId, logger));

  // Record the authorised user's incoming messages (private chat only).
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    if (chatId === config.allowedUserId && typeof messageId === "number") {
      await tracker.recordUserMessage(chatId, messageId).catch(() => undefined);
    }
    await next();
  });

  const sender: NotificationSender =
    options.sender ??
    (async ({ chatId, text, parseMode }) => {
      const sent = await bot.api.sendMessage(
        chatId,
        text,
        parseMode === "MarkdownV2" ? { parse_mode: "MarkdownV2" } : {},
      );
      return sent.message_id;
    });

  const savedVacancies = new SavedVacancyService({
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const notifier = new Notifier({
    store,
    sender,
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
    // Index each delivered job card so a later /save can resolve the vacancy.
    onDelivered: async ({ chatId, messageId, vacancies }) => {
      await savedVacancies.recordDelivered(chatId, messageId, vacancies);
    },
  });

  const search =
    options.search ??
    createScheduledSearch({
      logger,
      sponsorRegister: createDefaultSponsorRegister(process.env, fetch, logger),
    });

  const scheduler = new Scheduler({
    store,
    search,
    notifier,
    logger,
    chatId: config.allowedUserId,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(config.maxNotificationsPerRun === undefined
      ? {}
      : { maxNotificationsPerRun: config.maxNotificationsPerRun }),
  });

  registerHandlers(bot, config, logger, { store, tracker, scheduler, notifier, savedVacancies });

  bot.catch((error) => {
    logger.error("Unhandled bot error", error.error);
  });

  return { bot, services: { store, tracker, scheduler, notifier, savedVacancies } };
}

/**
 * Backwards-compatible factory returning the bare `Bot`. Prefer
 * {@link createBotApp} when the scheduler or its services are needed.
 */
export function createBot(
  config: AppConfig,
  logger: Logger,
  options: CreateBotOptions = {},
): Bot {
  return createBotApp(config, logger, options).bot;
}