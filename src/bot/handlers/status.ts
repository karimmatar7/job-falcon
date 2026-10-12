import type { Context } from "grammy";
import type { AppConfig } from "../../config/env.js";
import { PHASE, buildStatusMessage } from "../../messages.js";
import type { BotServices } from "../services.js";

export function createStatusHandler(
  config: AppConfig,
  services?: BotServices,
): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    if (services === undefined) {
      await ctx.reply(
        buildStatusMessage({
          allowedUserId: config.allowedUserId,
          phase: PHASE,
        }),
      );
      return;
    }

    const state = await services.store.get();
    const scheduling = {
      settings: state.schedule.settings,
      recentRuns: state.schedule.recentRuns,
      pendingNotifications: state.notifications.pending.length,
      ...(state.schedule.nextRunAt === undefined
        ? {}
        : { nextRunAt: state.schedule.nextRunAt }),
      ...(state.schedule.lastRun === undefined ? {} : { lastRun: state.schedule.lastRun }),
    };
    await ctx.reply(
      buildStatusMessage({
        allowedUserId: config.allowedUserId,
        phase: PHASE,
        scheduling,
      }),
    );
  };
}