import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const VALID_ENV = {
  TELEGRAM_BOT_TOKEN: "123456789:AAExampleTokenValue",
  TELEGRAM_ALLOWED_USER_ID: "987654321",
};

describe("loadConfig", () => {
  it("loads and coerces valid environment variables", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.telegramBotToken).toBe(VALID_ENV.TELEGRAM_BOT_TOKEN);
    expect(config.allowedUserId).toBe(987654321);
  });

  it("throws ConfigError when the token is missing", () => {
    const { TELEGRAM_BOT_TOKEN: _omitted, ...rest } = VALID_ENV;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
  });

  it("throws ConfigError when the allowed user id is missing", () => {
    const { TELEGRAM_ALLOWED_USER_ID: _omitted, ...rest } = VALID_ENV;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
  });

  it("rejects a non-numeric user id", () => {
    expect(() => loadConfig({ ...VALID_ENV, TELEGRAM_ALLOWED_USER_ID: "abc" })).toThrow(
      ConfigError,
    );
  });

  it("rejects a malformed bot token", () => {
    expect(() => loadConfig({ ...VALID_ENV, TELEGRAM_BOT_TOKEN: "not-a-token" })).toThrow(
      ConfigError,
    );
  });

  it("never includes secret values in the error message", () => {
    const secretLookingValue = "supersecretvalue";
    try {
      loadConfig({ ...VALID_ENV, TELEGRAM_BOT_TOKEN: secretLookingValue });
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secretLookingValue);
      expect((error as Error).message).toContain("TELEGRAM_BOT_TOKEN");
    }
  });
});
