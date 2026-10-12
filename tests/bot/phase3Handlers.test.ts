import { describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { createScheduleHandler } from "../../src/bot/handlers/schedule.js";
import { createPauseHandler, createResumeHandler } from "../../src/bot/handlers/pauseResume.js";
import { createEmptyHandler } from "../../src/bot/handlers/empty.js";
import { createSaveHandler, createSavedListHandler } from "../../src/bot/handlers/save.js";
import { createBotApp } from "../../src/bot/createBot.js";
import type { NotificationSender } from "../../src/services/scheduling/notifications.js";
import type { JobSearchFn } from "../../src/services/scheduling/searchRunner.js";
import type { BotServices } from "../../src/bot/services.js";
import { InMemoryStateStore, createInitialState } from "../../src/services/state/stateStore.js";
import { MessageTracker } from "../../src/services/conversation/messageTracker.js";
import { SavedVacancyService } from "../../src/services/savedVacancies.js";
import { Notifier } from "../../src/services/scheduling/notifications.js";
import { Scheduler } from "../../src/services/scheduling/scheduler.js";
import {
  ALERTS_PAUSED_MESSAGE,
  ALERTS_RESUMED_MESSAGE,
  EMPTY_NO_HISTORY_MESSAGE,
  SAVED_EMPTY_MESSAGE,
  SAVE_NO_RECENT_MESSAGE,
  SCHEDULE_TURNED_OFF_MESSAGE,
} from "../../src/messages.js";
import { FakeTimers, makeJobSearchResult, makeVacancy, silentLogger } from "../testKit.js";

const CHAT_ID = 42;
const NOW = new Date("2026-06-01T09:00:00.000Z");

function makeServices() {
  const store = new InMemoryStateStore(createInitialState());
  const tracker = new MessageTracker(store, { now: () => NOW });
  const sender = vi.fn(async () => 100);
  const notifier = new Notifier({
    store,
    sender: sender as unknown as NotificationSender,
    logger: silentLogger,
    now: () => NOW,
  });
  const search = vi.fn(async () => makeJobSearchResult([]));
  const scheduler = new Scheduler({
    store,
    search: search as unknown as JobSearchFn,
    notifier,
    logger: silentLogger,
    chatId: CHAT_ID,
    now: () => NOW,
    timers: new FakeTimers(),
  });
  const savedVacancies = new SavedVacancyService({ store, now: () => NOW });
  const services: BotServices = { store, tracker, scheduler, notifier, savedVacancies };
  return { services, store, tracker, scheduler, notifier, savedVacancies, sender, search };
}

function makeCtx(
  text: string,
  replyToMessageId?: number,
): {
  ctx: Context;
  reply: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  const deleteMessage = vi.fn(async () => true);
  const message: Record<string, unknown> = { text };
  if (replyToMessageId !== undefined) {
    message.reply_to_message = { message_id: replyToMessageId };
  }
  const ctx = {
    message,
    chat: { id: CHAT_ID },
    from: { id: CHAT_ID },
    reply,
    api: { deleteMessage },
  } as unknown as Context;
  return { ctx, reply, deleteMessage };
}

describe("/schedule", () => {
  it("shows the current settings with no arguments", async () => {
    const { services } = makeServices();
    const { ctx, reply } = makeCtx("/schedule");
    await createScheduleHandler(services)(ctx);

    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Current schedule");
    expect(text).toContain("Status: ENABLED");
    expect(text).toContain("Alerts: active");
    expect(text).toContain("08:00 (Europe/London)");
    expect(text).toContain("Query: keywords software developer, limit 10");
  });

  it("reports when already enabled", async () => {
    const { services } = makeServices();
    const { ctx, reply } = makeCtx("/schedule on");
    await createScheduleHandler(services)(ctx);
    expect(String(reply.mock.calls[0]?.[0])).toContain("already ENABLED");
  });

  it("enables scheduling and computes the next run", async () => {
    const { services, store, scheduler } = makeServices();
    await store.update((draft) => {
      draft.schedule.settings.enabled = false;
      delete draft.schedule.nextRunAt;
    });
    const reschedule = vi.spyOn(scheduler, "reschedule");
    const { ctx, reply } = makeCtx("/schedule on");
    await createScheduleHandler(services)(ctx);

    expect(String(reply.mock.calls[0]?.[0])).toContain("Automatic searches are now ENABLED");
    const state = await store.get();
    expect(state.schedule.settings.enabled).toBe(true);
    expect(state.schedule.nextRunAt).toBe("2026-06-02T07:00:00.000Z");
    expect(reschedule).toHaveBeenCalled();
  });

  it("disables scheduling but keeps the settings", async () => {
    const { services, store } = makeServices();
    await store.update((draft) => {
      draft.schedule.nextRunAt = "2026-06-02T07:00:00.000Z";
    });
    const { ctx, reply } = makeCtx("/schedule off");
    await createScheduleHandler(services)(ctx);

    expect(reply).toHaveBeenCalledWith(SCHEDULE_TURNED_OFF_MESSAGE);
    const state = await store.get();
    expect(state.schedule.settings.enabled).toBe(false);
    expect(state.schedule.settings.time).toBe("08:00");
    expect(state.schedule.nextRunAt).toBeUndefined();
  });

  it("sets the daily time", async () => {
    const { services, store } = makeServices();
    const { ctx, reply } = makeCtx("/schedule time 09:30");
    await createScheduleHandler(services)(ctx);

    expect(String(reply.mock.calls[0]?.[0])).toContain("Daily search time set to 09:30");
    expect((await store.get()).schedule.settings.time).toBe("09:30");
  });

  it("normalises a time without a leading zero", async () => {
    const { services, store } = makeServices();
    const { ctx } = makeCtx("/schedule time 9:30");
    await createScheduleHandler(services)(ctx);
    expect((await store.get()).schedule.settings.time).toBe("09:30");
  });

  it("rejects an invalid time without touching the schedule", async () => {
    const { services, store } = makeServices();
    const { ctx, reply } = makeCtx("/schedule time 25:00");
    await createScheduleHandler(services)(ctx);

    expect(String(reply.mock.calls[0]?.[0])).toContain(`"25:00" is not a valid time`);
    expect((await store.get()).schedule.settings.time).toBe("08:00");
  });

  it("sets the timezone", async () => {
    const { services, store } = makeServices();
    const { ctx, reply } = makeCtx("/schedule timezone Europe/Paris");
    await createScheduleHandler(services)(ctx);

    expect(String(reply.mock.calls[0]?.[0])).toContain(
      "Daily search timezone set to Europe/Paris",
    );
    expect((await store.get()).schedule.settings.timeZone).toBe("Europe/Paris");
  });

  it("rejects an unknown timezone", async () => {
    const { services, store } = makeServices();
    const { ctx, reply } = makeCtx("/schedule timezone Mars/Olympus");
    await createScheduleHandler(services)(ctx);

    expect(String(reply.mock.calls[0]?.[0])).toContain(
      "not a recognised IANA timezone",
    );
    expect((await store.get()).schedule.settings.timeZone).toBe("Europe/London");
  });

  it("explains unknown subcommands with usage help", async () => {
    const { services } = makeServices();
    const { ctx, reply } = makeCtx("/schedule fast");
    await createScheduleHandler(services)(ctx);

    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain('I do not understand "/schedule fast"');
    expect(text).toContain("Schedule options:");
    expect(text).toContain("Usage: /schedule on");
  });
});

describe("/pause and /resume", () => {
  it("/pause silences alerts and persists the flag", async () => {
    const { services, store } = makeServices();
    const { ctx, reply } = makeCtx("/pause");
    await createPauseHandler(services)(ctx);

    expect(reply).toHaveBeenCalledWith(ALERTS_PAUSED_MESSAGE);
    expect((await store.get()).schedule.settings.alertsPaused).toBe(true);
  });

  it("/resume clears the paused flag", async () => {
    const { services, store } = makeServices();
    await store.update((draft) => {
      draft.schedule.settings.alertsPaused = true;
    });
    const { ctx, reply } = makeCtx("/resume");
    await createResumeHandler(services)(ctx);

    expect(reply).toHaveBeenCalledWith(ALERTS_RESUMED_MESSAGE);
    expect((await store.get()).schedule.settings.alertsPaused).toBe(false);
  });

  it("/resume flushes waiting notifications and reports the outcome", async () => {
    const { services, notifier, sender } = makeServices();
    await notifier.enqueue([makeVacancy()], CHAT_ID);
    const { ctx, reply } = makeCtx("/resume");
    await createResumeHandler(services)(ctx);

    expect(sender).toHaveBeenCalledTimes(1);
    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("delivered 1");
    expect(text).toContain("still queued 0");
    expect((await services.store.get()).notifications.pending).toHaveLength(0);
  });
});

describe("/empty", () => {
  it("deletes every tracked message and preserves application data", async () => {
    const { services, store, notifier } = makeServices();
    // Persistent data that /empty must never touch.
    await store.update((draft) => {
      draft.schedule.settings.time = "07:00";
    });
    await notifier.enqueue([makeVacancy()], CHAT_ID);
    // Recent (within Telegram's 48h window, per the real clock).
    await store.update((draft) => {
      draft.conversations.byChat[String(CHAT_ID)] = {
        messages: [
          { id: 11, at: new Date().toISOString(), direction: "bot" },
          { id: 12, at: new Date().toISOString(), direction: "user" },
        ],
      };
    });

    const { ctx, reply, deleteMessage } = makeCtx("/empty");
    await createEmptyHandler(services)(ctx);

    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(deleteMessage).toHaveBeenCalledWith(CHAT_ID, 11);
    expect(deleteMessage).toHaveBeenCalledWith(CHAT_ID, 12);
    expect(String(reply.mock.calls[0]?.[0])).toContain("Messages deleted: 2");

    const state = await store.get();
    expect(state.conversations.byChat[String(CHAT_ID)]).toBeUndefined();
    expect(state.schedule.settings.time).toBe("07:00");
    expect(state.notifications.pending).toHaveLength(1);
    // The confirmation reply is never deleted (it is sent after cleanup).
    expect(deleteMessage).toHaveBeenCalledTimes(2);
  });

  it("reports when nothing has been tracked yet", async () => {
    const { services } = makeServices();
    const { ctx, reply, deleteMessage } = makeCtx("/empty");
    await createEmptyHandler(services)(ctx);

    expect(reply).toHaveBeenCalledWith(EMPTY_NO_HISTORY_MESSAGE);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("skips messages older than 48 hours and says so", async () => {
    const { services, store } = makeServices();
    await store.update((draft) => {
      draft.conversations.byChat[String(CHAT_ID)] = {
        messages: [
          { id: 1, at: "2020-01-01T00:00:00.000Z", direction: "bot" },
          { id: 2, at: new Date().toISOString(), direction: "bot" },
        ],
      };
    });
    const { ctx, reply, deleteMessage } = makeCtx("/empty");
    await createEmptyHandler(services)(ctx);

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalledWith(CHAT_ID, 1);
    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("1 older than Telegram's 48-hour deletion window");
  });

  it("reports Telegram rejections truthfully", async () => {
    const { services, store } = makeServices();
    await store.update((draft) => {
      draft.conversations.byChat[String(CHAT_ID)] = {
        messages: [{ id: 20, at: new Date().toISOString(), direction: "bot" }],
      };
    });
    const { ctx, reply, deleteMessage } = makeCtx("/empty");
    deleteMessage.mockRejectedValue(new Error("telegram: 400 Bad Request: message is too old"));
    await createEmptyHandler(services)(ctx);

    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Messages deleted: 0");
    expect(text).toContain("rejected by Telegram as too old or already gone");
    // The bot still clears its own history record.
    expect((await services.store.get()).conversations.byChat[String(CHAT_ID)]).toBeUndefined();
  });

  it("handles a missing chat id gracefully", async () => {
    const { services } = makeServices();
    const reply: ReturnType<typeof vi.fn> = vi.fn(async () => undefined);
    const ctx = { message: { text: "/empty" }, reply } as unknown as Context;
    await createEmptyHandler(services)(ctx);
    expect(String(reply.mock.calls[0]?.[0])).toContain("could not determine this chat");
  });

  it("keeps saved vacancy messages while deleting the rest", async () => {
    const { services, store, notifier, savedVacancies } = makeServices();
    await store.update((draft) => {
      draft.schedule.settings.time = "06:30";
    });
    await notifier.enqueue([makeVacancy()], CHAT_ID);

    // Vacancy delivered as message 30, then explicitly saved.
    await savedVacancies.recordDelivered(CHAT_ID, 30, [makeVacancy()]);
    await savedVacancies.save(CHAT_ID);

    await store.update((draft) => {
      draft.conversations.byChat[String(CHAT_ID)] = {
        messages: [
          { id: 10, at: new Date().toISOString(), direction: "bot" },
          { id: 11, at: new Date().toISOString(), direction: "bot" },
          { id: 12, at: new Date().toISOString(), direction: "user" },
          { id: 30, at: new Date().toISOString(), direction: "bot" },
        ],
      };
    });

    const { ctx, reply, deleteMessage } = makeCtx("/empty");
    await createEmptyHandler(services)(ctx);

    // Unsaved messages deleted; the saved one is never attempted.
    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(deleteMessage).toHaveBeenCalledWith(CHAT_ID, 10);
    expect(deleteMessage).toHaveBeenCalledWith(CHAT_ID, 11);
    expect(deleteMessage).toHaveBeenCalledWith(CHAT_ID, 12);
    expect(deleteMessage).not.toHaveBeenCalledWith(CHAT_ID, 30);

    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Messages deleted: 3");
    expect(text).toContain("Saved vacancy messages preserved: 1");

    // The saved record and its message association survive the cleanup.
    expect(await savedVacancies.listSaved(CHAT_ID)).toHaveLength(1);
    expect(await savedVacancies.savedMessageIds(CHAT_ID)).toEqual(new Set([30]));

    // Scheduler and notification state are untouched.
    const state = await store.get();
    expect(state.schedule.settings.time).toBe("06:30");
    expect(state.notifications.pending).toHaveLength(1);
  });

  it("keeps a saved vacancy message even when it is too old to delete", async () => {
    const { services, store, savedVacancies } = makeServices();
    await savedVacancies.recordDelivered(CHAT_ID, 30, [makeVacancy()]);
    await savedVacancies.save(CHAT_ID);
    await store.update((draft) => {
      draft.conversations.byChat[String(CHAT_ID)] = {
        messages: [
          { id: 30, at: "2020-01-01T00:00:00.000Z", direction: "bot" },
          { id: 40, at: "2020-01-01T00:00:00.000Z", direction: "bot" },
        ],
      };
    });

    const { ctx, reply, deleteMessage } = makeCtx("/empty");
    await createEmptyHandler(services)(ctx);

    // Neither is attempted: one is protected, the other is outside the window.
    expect(deleteMessage).not.toHaveBeenCalled();
    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Saved vacancy messages preserved: 1");
    expect(text).toContain("older than Telegram's 48-hour deletion window");
    expect(await savedVacancies.listSaved(CHAT_ID)).toHaveLength(1);
  });

  it("mentions saved messages even when there is no disposable history", async () => {
    const { services, savedVacancies } = makeServices();
    await savedVacancies.recordDelivered(CHAT_ID, 30, [makeVacancy()]);
    await savedVacancies.save(CHAT_ID);

    const { ctx, reply, deleteMessage } = makeCtx("/empty");
    await createEmptyHandler(services)(ctx);

    expect(deleteMessage).not.toHaveBeenCalled();
    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("nothing for me to clear");
    expect(text).toContain("saved vacancy");
  });
});

describe("/save and /saved", () => {
  it("saves the most recent vacancy and protects its message", async () => {
    const { services, savedVacancies } = makeServices();
    await savedVacancies.recordDelivered(CHAT_ID, 100, [makeVacancy()]);

    const { ctx, reply } = makeCtx("/save");
    await createSaveHandler(services)(ctx);

    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Saved vacancy #1");
    expect(text).toContain("Graduate Software Developer");
    expect(await savedVacancies.listSaved(CHAT_ID)).toHaveLength(1);
    expect(await savedVacancies.savedMessageIds(CHAT_ID)).toEqual(new Set([100]));
  });

  it("explains when there is no recent vacancy", async () => {
    const { services } = makeServices();
    const { ctx, reply } = makeCtx("/save");
    await createSaveHandler(services)(ctx);
    expect(reply).toHaveBeenCalledWith(SAVE_NO_RECENT_MESSAGE);
  });

  it("asks which vacancy to save from a multi-vacancy message", async () => {
    const { services, savedVacancies } = makeServices();
    await savedVacancies.recordDelivered(CHAT_ID, 9, [
      makeVacancy({ id: "j1" }),
      makeVacancy({ id: "j2", title: "Data Analyst", employer: "Other Ltd" }),
    ]);

    const { ctx, reply } = makeCtx("/save");
    await createSaveHandler(services)(ctx);

    expect(String(reply.mock.calls[0]?.[0])).toContain("several vacancies");
    expect(await savedVacancies.listSaved(CHAT_ID)).toHaveLength(0);
  });

  it("saves the chosen number from a multi-vacancy message", async () => {
    const { services, savedVacancies } = makeServices();
    await savedVacancies.recordDelivered(CHAT_ID, 9, [
      makeVacancy({ id: "j1" }),
      makeVacancy({ id: "j2", title: "Data Analyst", employer: "Other Ltd" }),
    ]);

    const { ctx } = makeCtx("/save 2");
    await createSaveHandler(services)(ctx);

    const saved = await savedVacancies.listSaved(CHAT_ID);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.vacancy.id).toBe("j2");
    expect(saved[0]?.messageId).toBe(9);
  });

  it("saves from the message the command replies to", async () => {
    const { services, savedVacancies } = makeServices();
    await savedVacancies.recordDelivered(CHAT_ID, 100, [makeVacancy({ id: "j1" })]);
    await savedVacancies.recordDelivered(CHAT_ID, 200, [
      makeVacancy({ id: "j2", title: "Data Analyst", employer: "Other Ltd" }),
    ]);

    const { ctx } = makeCtx("/save", 100);
    await createSaveHandler(services)(ctx);

    const saved = await savedVacancies.listSaved(CHAT_ID);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.vacancy.id).toBe("j1");
  });

  it("lists saved vacancies", async () => {
    const { services, savedVacancies } = makeServices();
    await savedVacancies.recordDelivered(CHAT_ID, 100, [makeVacancy()]);
    await savedVacancies.save(CHAT_ID);

    const { ctx, reply } = makeCtx("/saved");
    await createSavedListHandler(services)(ctx);

    const text = String(reply.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Saved vacancies (1)");
    expect(text).toContain("Graduate Software Developer");
  });

  it("says when nothing has been saved", async () => {
    const { services } = makeServices();
    const { ctx, reply } = makeCtx("/saved");
    await createSavedListHandler(services)(ctx);
    expect(reply).toHaveBeenCalledWith(SAVED_EMPTY_MESSAGE);
  });
});

describe("authorisation and wiring", () => {
  type BotUpdate = Parameters<Bot["handleUpdate"]>[0];

  function makeUpdate(text: string, fromId: number): BotUpdate {
    return {
      update_id: 1,
      message: {
        message_id: 10,
        date: Math.floor(NOW.getTime() / 1000),
        chat: { id: fromId, type: "private" },
        from: { id: fromId, is_bot: false, first_name: "User" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: text.length }],
      },
    } as BotUpdate;
  }

  function makeBotApp() {
    const store = new InMemoryStateStore(createInitialState());
    const app = createBotApp(
      { telegramBotToken: "123456:TESTTOKEN", allowedUserId: CHAT_ID },
      silentLogger,
      {
        persistent: false,
        store,
        now: () => NOW,
        timers: new FakeTimers(),
        search: vi.fn(async () => makeJobSearchResult([])),
        sender: vi.fn(async () => 1),
      },
    );
    // handleUpdate needs a known bot identity; no network call is wanted.
    app.bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: "JobScout",
      username: "job_scout_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    } as NonNullable<Bot["botInfo"]>;
    // Intercept the Telegram API so the test never touches the network.
    app.bot.api.config.use(async (prev, method, payload) => {
      if (method === "sendMessage" || method === "deleteMessage") {
        return { ok: true, result: { message_id: 1 } } as never;
      }
      return prev(method, payload);
    });
    return app;
  }

  it("blocks an unauthorised user from controlling the schedule", async () => {
    const app = makeBotApp();
    await app.bot.handleUpdate(makeUpdate("/pause", 666));

    const state = await app.services.store.get();
    expect(state.schedule.settings.alertsPaused).toBe(false);
  });

  it("lets the authorised user run Phase 3 commands through the bot boundary", async () => {
    const app = makeBotApp();
    await app.bot.handleUpdate(makeUpdate("/pause", CHAT_ID));

    const state = await app.services.store.get();
    expect(state.schedule.settings.alertsPaused).toBe(true);
  });

  it("registers the Phase 3 commands behind the auth wall", async () => {
    const app = makeBotApp();
    await app.bot.handleUpdate(makeUpdate("/schedule", CHAT_ID));

    const state = await app.services.store.get();
    expect(state.schedule.settings.enabled).toBe(true); // handler ran
  });
});