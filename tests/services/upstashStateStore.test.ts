import { describe, expect, it } from "vitest";
import { UpstashStateStore } from "../../src/services/state/upstashStateStore.js";
import { createInitialState } from "../../src/services/state/stateStore.js";
import type { PersistedState } from "../../src/services/state/stateStore.js";
import { silentLogger } from "../testKit.js";

const URL = "https://example-db.upstash.io";
const TOKEN = "rest-token-value";
const KEY = "job-scout:state";

type Command = unknown[];

interface Outcome {
  result?: unknown;
  error?: unknown;
  status?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(handler: (command: Command) => Outcome) {
  const calls: Array<{
    url: string;
    command: Command;
    authorization: string | undefined;
  }> = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as Command;
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      command,
      authorization: headers.get("authorization") ?? undefined,
    });
    const outcome = handler(command);
    const status = outcome.status ?? 200;
    const body =
      outcome.error !== undefined
        ? { error: outcome.error }
        : { result: outcome.result ?? null };
    return jsonResponse(body, status);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function makeStore(
  handler: (command: Command) => Outcome,
  options: { initial?: PersistedState; key?: string } = {},
) {
  const { fetcher, calls } = fakeFetch(handler);
  const store = new UpstashStateStore({
    url: URL,
    token: TOKEN,
    logger: silentLogger,
    fetcher,
    ...options,
  });
  return { store, calls };
}

describe("UpstashStateStore", () => {
  it("returns defaults when the key is missing", async () => {
    const { store, calls } = makeStore(() => ({ result: null }));

    const state = await store.get();

    expect(state.version).toBe(1);
    expect(state.savedVacancies.entries).toEqual([]);
    expect(calls[0]?.command).toEqual(["GET", KEY]);
    expect(calls[0]?.url).toBe(URL);
    expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    // The token is never placed in the URL.
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("loads and validates an existing document", async () => {
    const existing = createInitialState();
    existing.schedule.settings.time = "07:30";
    const { store } = makeStore(() => ({ result: JSON.stringify(existing) }));

    const state = await store.get();

    expect(state.schedule.settings.time).toBe("07:30");
  });

  it("persists updates with SET", async () => {
    const { store, calls } = makeStore((command) =>
      command[0] === "GET" ? { result: null } : { result: "OK" },
    );

    await store.update((draft) => {
      draft.schedule.settings.time = "09:15";
    });

    const set = calls.find((call) => call.command[0] === "SET");
    expect(set?.command[1]).toBe(KEY);
    expect(JSON.parse(String(set?.command[2])).schedule.settings.time).toBe("09:15");
  });

  it("backs up and resets corrupt data instead of crashing", async () => {
    const { store, calls } = makeStore((command) =>
      command[0] === "GET" ? { result: "{not valid json" } : { result: "OK" },
    );

    const state = await store.get();

    expect(state.version).toBe(1);
    const backup = calls.find((call) => String(call.command[1]).startsWith(`${KEY}:corrupt:`));
    expect(backup?.command[2]).toBe("{not valid json");
  });

  it("throws when the HTTP request fails", async () => {
    const { store } = makeStore(() => ({ status: 503 }));
    await expect(store.get()).rejects.toThrow(/status 503/);
  });

  it("throws when the command returns an error payload", async () => {
    const { store } = makeStore(() => ({ error: "ERR rate limited" }));
    await expect(store.get()).rejects.toThrow(/Upstash command failed/);
  });

  it("acquires a lock with SET NX PX", async () => {
    const { store, calls } = makeStore(() => ({ result: "OK" }));

    expect(await store.acquireLock("owner-1", 60_000)).toBe(true);
    expect(calls[0]?.command).toEqual([
      "SET",
      `${KEY}:lock`,
      "owner-1",
      "NX",
      "PX",
      60_000,
    ]);
  });

  it("reports a held lock as not acquired", async () => {
    const { store } = makeStore(() => ({ result: null }));
    expect(await store.acquireLock("owner-2", 1_000)).toBe(false);
  });

  it("releases a lock with a compare-and-delete script", async () => {
    const { store, calls } = makeStore(() => ({ result: 1 }));

    await store.releaseLock("owner-3");

    expect(calls[0]?.command[0]).toBe("EVAL");
    expect(calls[0]?.command[2]).toBe("1");
    expect(calls[0]?.command[3]).toBe(`${KEY}:lock`);
    expect(calls[0]?.command[4]).toBe("owner-3");
  });
});
