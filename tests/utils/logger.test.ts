import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, redactSecrets, toLogString } from "../../src/utils/logger.js";

describe("redactSecrets", () => {
  it("replaces occurrences of a secret", () => {
    expect(redactSecrets("token=SECRET123", ["SECRET123"])).toBe("token=[REDACTED]");
  });

  it("replaces every occurrence", () => {
    expect(redactSecrets("SECRET123 and SECRET123", ["SECRET123"])).toBe(
      "[REDACTED] and [REDACTED]",
    );
  });

  it("ignores very short secrets to avoid corrupting text", () => {
    expect(redactSecrets("a b c", ["a"])).toBe("a b c");
  });
});

describe("toLogString", () => {
  it("uses the stack for errors", () => {
    expect(toLogString(new Error("boom"))).toContain("boom");
  });

  it("serialises plain objects", () => {
    expect(toLogString({ a: 1 })).toBe('{"a":1}');
  });
});

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never writes the secret token to the console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger(["SUPERSECRET"]);

    logger.info("boot with SUPERSECRET", { token: "SUPERSECRET" });

    const output = spy.mock.calls.flat().join(" ");
    expect(output).not.toContain("SUPERSECRET");
    expect(output).toContain("[REDACTED]");
  });
});
