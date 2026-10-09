import { describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { createAuthMiddleware, isAuthorized } from "../../src/bot/auth.js";
import { createLogger } from "../../src/utils/logger.js";

const silentLogger = createLogger();

function makeCtx(userId: number | undefined): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async () => undefined);
  const from = userId === undefined ? undefined : { id: userId };
  return { ctx: { from, reply } as unknown as Context, reply };
}

describe("isAuthorized", () => {
  it("allows the configured user", () => {
    expect(isAuthorized(42, 42)).toBe(true);
  });

  it("blocks any other user", () => {
    expect(isAuthorized(43, 42)).toBe(false);
  });

  it("blocks an unknown user", () => {
    expect(isAuthorized(undefined, 42)).toBe(false);
  });
});

describe("createAuthMiddleware", () => {
  it("calls next for the authorised user", async () => {
    const { ctx } = makeCtx(42);
    const next = vi.fn(async () => undefined) as unknown as NextFunction;

    await createAuthMiddleware(42, silentLogger)(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks unauthorised users without calling next", async () => {
    const { ctx, reply } = makeCtx(7);
    const next = vi.fn(async () => undefined) as unknown as NextFunction;

    await createAuthMiddleware(42, silentLogger)(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it("still blocks when the sender is missing (e.g. channel post)", async () => {
    const { ctx } = makeCtx(undefined);
    const next = vi.fn(async () => undefined) as unknown as NextFunction;

    await createAuthMiddleware(42, silentLogger)(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });
});
