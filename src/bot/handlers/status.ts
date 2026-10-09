import type { Context } from "grammy";
import type { AppConfig } from "../../config/env.js";
import { PHASE, buildStatusMessage } from "../../messages.js";

export function createStatusHandler(
  config: AppConfig,
): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    await ctx.reply(
      buildStatusMessage({ allowedUserId: config.allowedUserId, phase: PHASE }),
    );
  };
}
