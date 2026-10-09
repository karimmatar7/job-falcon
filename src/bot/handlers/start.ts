import type { Context } from "grammy";
import { START_MESSAGE } from "../../messages.js";

export async function startHandler(ctx: Context): Promise<void> {
  await ctx.reply(START_MESSAGE);
}
