import { describe, expect, it } from "vitest";
import { resolveStateBackend } from "../../src/services/state/stateBackend.js";
import { DEFAULT_UPSTASH_STATE_KEY } from "../../src/services/state/upstashStateStore.js";

describe("resolveStateBackend", () => {
  it("defaults to a file when nothing durable is configured", () => {
    expect(resolveStateBackend({})).toEqual({ kind: "file" });
  });

  it("honours an explicit file or memory choice", () => {
    expect(resolveStateBackend({ JOB_SCOUT_STATE_BACKEND: "file" })).toEqual({
      kind: "file",
    });
    expect(resolveStateBackend({ JOB_SCOUT_STATE_BACKEND: "MEMORY" })).toEqual({
      kind: "memory",
    });
  });

  it("auto-detects Upstash when both credentials are present", () => {
    expect(
      resolveStateBackend({
        UPSTASH_REDIS_REST_URL: "https://db.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toEqual({
      kind: "upstash",
      url: "https://db.upstash.io",
      token: "token",
      key: DEFAULT_UPSTASH_STATE_KEY,
    });
  });

  it("does not auto-detect Upstash when a credential is missing", () => {
    expect(resolveStateBackend({ UPSTASH_REDIS_REST_URL: "https://db.upstash.io" })).toEqual(
      { kind: "file" },
    );
    expect(resolveStateBackend({ UPSTASH_REDIS_REST_TOKEN: "token" })).toEqual({
      kind: "file",
    });
  });

  it("uses a custom key when provided", () => {
    const backend = resolveStateBackend({
      JOB_SCOUT_STATE_BACKEND: "upstash",
      UPSTASH_REDIS_REST_URL: "https://db.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      JOB_SCOUT_STATE_REDIS_KEY: "my-namespace:state",
    });
    expect(backend).toMatchObject({ kind: "upstash", key: "my-namespace:state" });
  });

  it("throws when upstash is forced without credentials", () => {
    expect(() =>
      resolveStateBackend({ JOB_SCOUT_STATE_BACKEND: "upstash" }),
    ).toThrow(/UPSTASH_REDIS_REST_URL/);
  });

  it("throws on an unknown backend", () => {
    expect(() =>
      resolveStateBackend({ JOB_SCOUT_STATE_BACKEND: "sqlite" }),
    ).toThrow(/Unknown JOB_SCOUT_STATE_BACKEND/);
  });
});
