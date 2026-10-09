import type { Context } from "grammy";
import { HELP_MESSAGE } from "../../messages.js";

export async function helpHandler(ctx: Context): Promise<void> {
  await ctx.reply(HELP_MESSAGE);
}
