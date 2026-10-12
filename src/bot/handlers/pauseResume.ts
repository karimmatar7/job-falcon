import type { Context } from "grammy";
import type { BotServices } from "../services.js";
import { ALERTS_PAUSED_MESSAGE, ALERTS_RESUMED_MESSAGE } from "../../messages.js";

export function createPauseHandler(services: BotServices) {
  return async (ctx: Context): Promise<void> => {
    await services.store.update((draft) => {
      draft.schedule.settings.alertsPaused = true;
    });
    await ctx.reply(ALERTS_PAUSED_MESSAGE);
  };
}

export function createResumeHandler(services: BotServices) {
  return async (ctx: Context): Promise<void> => {
    await services.store.update((draft) => {
      draft.schedule.settings.alertsPaused = false;
    });

    const state = await services.store.get();
    const pending = state.notifications.pending.length;
    if (pending > 0) {
      const result = await services.notifier.deliverPending(pending);
      await ctx.reply(
        [
          ALERTS_RESUMED_MESSAGE,
          ...(result.delivered > 0 || result.failed > 0
            ? [
                "",
                `Waiting notifications: delivered ${result.delivered}, failed ${result.failed}, still queued ${result.remaining}.`,
              ]
            : []),
        ].join("\n"),
      );
      return;
    }
    await ctx.reply(ALERTS_RESUMED_MESSAGE);
  };
}