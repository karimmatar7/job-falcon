import type { Context, MiddlewareFn } from "grammy";
import { UNAUTHORIZED_MESSAGE } from "../messages.js";
import type { Logger } from "../utils/logger.js";

/** True only when `userId` is known and exactly matches the allowed user. */
export function isAuthorized(userId: number | undefined, allowedUserId: number): boolean {
  return typeof userId === "number" && Number.isInteger(userId) && userId === allowedUserId;
}

/**
 * Middleware that drops every update which does not come from the single
 * authorised Telegram user. Unauthorised users receive a generic message and
 * never reach any command handler.
 */
export function createAuthMiddleware(
  allowedUserId: number,
  logger: Logger,
): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (isAuthorized(ctx.from?.id, allowedUserId)) {
      await next();
      return;
    }

    logger.warn("Blocked unauthorised access attempt", {
      telegramUserId: ctx.from?.id ?? "unknown",
    });

    try {
      await ctx.reply(UNAUTHORIZED_MESSAGE);
    } catch {
      // Ignore failures replying to unauthorised users.
    }
  };
}
