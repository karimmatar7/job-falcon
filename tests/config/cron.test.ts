import { describe, expect, it } from "vitest";
import {
  resolveCronSecret,
  verifyCronAuthorization,
} from "../../src/config/cron.js";

describe("resolveCronSecret", () => {
  it("reads CRON_SECRET", () => {
    expect(resolveCronSecret({ CRON_SECRET: "s3cret-value" })).toBe("s3cret-value");
  });

  it("falls back to JOB_SCOUT_CRON_SECRET", () => {
    expect(resolveCronSecret({ JOB_SCOUT_CRON_SECRET: "alias-value" })).toBe(
      "alias-value",
    );
  });

  it("prefers CRON_SECRET when both are set", () => {
    expect(
      resolveCronSecret({ CRON_SECRET: "primary", JOB_SCOUT_CRON_SECRET: "alias" }),
    ).toBe("primary");
  });

  it("treats missing and blank values as unset", () => {
    expect(resolveCronSecret({})).toBeUndefined();
    expect(resolveCronSecret({ CRON_SECRET: "   " })).toBeUndefined();
    expect(resolveCronSecret({ CRON_SECRET: "" })).toBeUndefined();
  });
});

describe("verifyCronAuthorization", () => {
  const secret = "correct-horse-battery-staple";

  it("accepts the matching bearer header", () => {
    expect(verifyCronAuthorization(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyCronAuthorization(undefined, secret)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyCronAuthorization("Bearer nope", secret)).toBe(false);
  });

  it("rejects a missing scheme", () => {
    expect(verifyCronAuthorization(secret, secret)).toBe(false);
  });

  it("rejects a different scheme", () => {
    expect(verifyCronAuthorization(`Basic ${secret}`, secret)).toBe(false);
  });

  it("rejects an unset secret (fails closed)", () => {
    expect(verifyCronAuthorization("Bearer anything", undefined)).toBe(false);
    expect(verifyCronAuthorization("Bearer anything", "")).toBe(false);
  });

  it("rejects a header longer or shorter than expected", () => {
    expect(verifyCronAuthorization(`Bearer ${secret}extra`, secret)).toBe(false);
    expect(verifyCronAuthorization(`Bearer ${secret.slice(0, -1)}`, secret)).toBe(false);
  });
});
