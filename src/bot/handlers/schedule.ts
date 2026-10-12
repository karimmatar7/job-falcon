import type { Context } from "grammy";
import type { BotServices } from "../services.js";
import { parseCommand } from "../command.js";
import {
  formatWallClock,
  isValidTimeZone,
  nextRunAfter,
} from "../../services/scheduling/scheduleTime.js";
import type { ScheduleSettings } from "../../services/state/stateStore.js";
import {
  SCHEDULE_HELP,
  SCHEDULE_ON_USAGE,
  SCHEDULE_TURNED_OFF_MESSAGE,
  buildScheduleInvalidTimeMessage,
  buildScheduleInvalidTimeZoneMessage,
  buildScheduleSettingsMessage,
  buildScheduleTurnedOnMessage,
} from "../../messages.js";

/** Accept a leading zero now or later, normalising e.g. `8:00` to `08:00`. */
function normaliseTimeInput(value: string): string | undefined {
  const trimmed = value.trim();
  const strict = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (strict !== null) return trimmed;
  const loose = /^([0-9]|1\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (loose === null) return undefined;
  const hour = loose[1];
  const minute = loose[2];
  if (hour === undefined || minute === undefined) return undefined;
  return `${hour.padStart(2, "0")}:${minute}`;
}

function nextRunLine(settings: ScheduleSettings, nextRunAt: string | undefined): string {
  if (nextRunAt === undefined) return "";
  const target = new Date(nextRunAt);
  if (Number.isNaN(target.getTime())) return "";
  try {
    nextRunAfter(settings.time, settings.timeZone, new Date());
    return ` Next run ${formatWallClock(target, settings.timeZone)} (${settings.timeZone}).`;
  } catch {
    return ` Next run ${target.toISOString()}.`;
  }
}

export function createScheduleHandler(services: BotServices) {
  return async (ctx: Context): Promise<void> => {
    const parsed = parseCommand(ctx.message?.text);
    const args = parsed?.args ?? [];
    const { store, scheduler } = services;
    const state = await store.get();
    const settings = state.schedule.settings;

    if (args.length === 0) {
      await ctx.reply(
        buildScheduleSettingsMessage(settings, state.schedule.nextRunAt, new Date()),
      );
      return;
    }

    const action = args[0]?.toLowerCase();

    switch (action) {
      case "on": {
        if (settings.enabled) {
          await ctx.reply("Automatic searches are already ENABLED.");
          return;
        }
        await store.update((draft) => {
          draft.schedule.settings.enabled = true;
        });
        await scheduler.reschedule();
        const after = await store.get();
        await ctx.reply(
          buildScheduleTurnedOnMessage(
            after.schedule.settings,
            after.schedule.nextRunAt,
            new Date(),
          ),
        );
        return;
      }

      case "off": {
        if (!settings.enabled) {
          await ctx.reply("Automatic searches are already DISABLED.");
          return;
        }
        await store.update((draft) => {
          draft.schedule.settings.enabled = false;
          delete draft.schedule.nextRunAt;
        });
        await scheduler.reschedule();
        await ctx.reply(SCHEDULE_TURNED_OFF_MESSAGE);
        return;
      }

      case "time": {
        const value = args[1];
        const time = value === undefined ? undefined : normaliseTimeInput(value);
        if (time === undefined) {
          await ctx.reply(buildScheduleInvalidTimeMessage(value ?? ""));
          return;
        }
        await store.update((draft) => {
          draft.schedule.settings.time = time;
        });
        await scheduler.reschedule();
        const after = await store.get();
        const settingsAfter = after.schedule.settings;
        await ctx.reply(
          settingsAfter.enabled
            ? `Daily search time set to ${time} (${settingsAfter.timeZone}).\nNext run ${formatWallClock(
                nextRunAfter(time, settingsAfter.timeZone, new Date()),
                settingsAfter.timeZone,
              )} (${settingsAfter.timeZone}).`
            : `Daily search time set to ${time} (${settingsAfter.timeZone}). It will apply when scheduling is enabled (/schedule on).`,
        );
        return;
      }

      case "timezone": {
        const value = args[1];
        if (value === undefined || !isValidTimeZone(value)) {
          await ctx.reply(buildScheduleInvalidTimeZoneMessage(value ?? ""));
          return;
        }
        await store.update((draft) => {
          draft.schedule.settings.timeZone = value;
        });
        await scheduler.reschedule();
        const after = await store.get();
        const settingsAfter = after.schedule.settings;
        await ctx.reply(
          `Daily search timezone set to ${value}. Daily time is ${settingsAfter.time}.${nextRunLine(
            settingsAfter,
            after.schedule.nextRunAt,
          )}`,
        );
        return;
      }

      default:
        await ctx.reply(
          [
            `I do not understand "/schedule ${args.join(" ")}".`,
            "",
            SCHEDULE_HELP,
            "",
            SCHEDULE_ON_USAGE,
          ].join("\n"),
        );
    }
  };
}