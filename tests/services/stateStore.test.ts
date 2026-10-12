import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileStateStore,
  InMemoryStateStore,
  createInitialState,
  DEFAULT_SCHEDULE_KEYWORDS,
  DEFAULT_SCHEDULE_LIMIT,
  DEFAULT_SCHEDULE_TIME,
  DEFAULT_SCHEDULE_TIMEZONE,
  STATE_VERSION,
} from "../../src/services/state/stateStore.js";
import { makeVacancy, silentLogger } from "../testKit.js";

const cleanup: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "job-scout-state-"));
  cleanup.push(dir);
  return path.join(dir, "state.json");
}

afterEach(async () => {
  const dirs = cleanup.splice(0);
  await Promise.all(dirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("createInitialState", () => {
  it("creates a complete default state document", () => {
    const state = createInitialState();
    expect(state.version).toBe(STATE_VERSION);
    expect(state.schedule.settings).toEqual({
      enabled: true,
      alertsPaused: false,
      time: DEFAULT_SCHEDULE_TIME,
      timeZone: DEFAULT_SCHEDULE_TIMEZONE,
      keywords: [...DEFAULT_SCHEDULE_KEYWORDS],
      limit: DEFAULT_SCHEDULE_LIMIT,
    });
    expect(state.schedule.nextRunAt).toBeUndefined();
    expect(state.schedule.lastRun).toBeUndefined();
    expect(state.schedule.recentRuns).toEqual([]);
    expect(state.notifications).toEqual({ seen: {}, pending: [], history: [] });
    expect(state.conversations).toEqual({ byChat: {} });
    expect(state.savedVacancies).toEqual({ entries: [], nextId: 1 });
    expect(state.vacancyIndex).toEqual({ items: [] });
  });

  it("applies every override option", () => {
    const state = createInitialState({
      scheduleEnabled: false,
      scheduleTime: "07:30",
      scheduleTimeZone: "Europe/Paris",
      scheduleKeywords: ["react", "developer"],
      scheduleLimit: 3,
      scheduleLocation: "Leeds",
    });
    expect(state.schedule.settings).toEqual({
      enabled: false,
      alertsPaused: false,
      time: "07:30",
      timeZone: "Europe/Paris",
      keywords: ["react", "developer"],
      limit: 3,
      location: "Leeds",
    });
  });

  it("omits location when none is provided", () => {
    const state = createInitialState();
    expect(state.schedule.settings.location).toBeUndefined();
  });
});

describe("InMemoryStateStore", () => {
  it("applies updates and exposes the latest document", async () => {
    const store = new InMemoryStateStore();
    await store.update((draft) => {
      draft.schedule.settings.time = "09:45";
    });
    const state = await store.get();
    expect(state.schedule.settings.time).toBe("09:45");
  });

  it("returns immutable snapshots", async () => {
    const store = new InMemoryStateStore();
    const first = await store.get();
    first.schedule.settings.time = "99:99";
    first.notifications.seen["nope"] = {
      firstSeenAt: "x",
      lastSeenAt: "x",
      status: "seen",
    };
    const second = await store.get();
    expect(second.schedule.settings.time).toBe(DEFAULT_SCHEDULE_TIME);
    expect(second.notifications.seen["nope"]).toBeUndefined();
  });

  it("rejects updates that would corrupt the document", async () => {
    const store = new InMemoryStateStore();
    await expect(
      store.update((draft) => {
        // Cast is intentional: we are testing the schema guard.
        (draft as { schedule: { settings: { enabled: unknown } } }).schedule.settings.enabled =
          "yes";
      }),
    ).rejects.toThrow();
    const state = await store.get();
    expect(state.schedule.settings.enabled).toBe(true);
  });
});

describe("FileStateStore", () => {
  it("persists an update and reloads it from disk", async () => {
    const file = await tempFile();
    const store = new FileStateStore({ filePath: file, logger: silentLogger });
    await store.update((draft) => {
      draft.schedule.settings.time = "09:30";
      draft.notifications.seen["url:https://example.com/jobs/1"] = {
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        status: "notified",
      };
    });

    const reloaded = new FileStateStore({ filePath: file, logger: silentLogger });
    const state = await reloaded.get();
    expect(state.schedule.settings.time).toBe("09:30");
    expect(state.notifications.seen["url:https://example.com/jobs/1"]?.status).toBe(
      "notified",
    );
  });

  it("starts from the initial document when no file exists", async () => {
    const file = await tempFile();
    const store = new FileStateStore({ filePath: file, logger: silentLogger });
    const state = await store.get();
    expect(state).toEqual(createInitialState());
  });

  it("quarantines a corrupt file and falls back to defaults", async () => {
    const file = await tempFile();
    await fsp.writeFile(file, "{ definitely not json !!", "utf8");
    const store = new FileStateStore({ filePath: file, logger: silentLogger });
    const state = await store.get();
    expect(state).toEqual(createInitialState());

    const entries = await fsp.readdir(path.dirname(file));
    const backup = entries.find((entry) => entry.startsWith("state.json.corrupt-"));
    expect(backup).toBeDefined();
    const backedUp = await fsp.readFile(path.join(path.dirname(file), backup ?? ""), "utf8");
    expect(backedUp).toContain("definitely not json");
  });

  it("quarantines a structurally-valid but schema-invalid file", async () => {
    const file = await tempFile();
    await fsp.writeFile(file, JSON.stringify({ version: 1, schedule: "oops" }), "utf8");
    const store = new FileStateStore({ filePath: file, logger: silentLogger });
    const state = await store.get();
    expect(state.schedule.settings.enabled).toBe(true);
  });

  it("loads an older state file without the saved-vacancy sections", async () => {
    const file = await tempFile();
    // A document written before saved vacancies / the /save index existed.
    const legacy = createInitialState() as Record<string, unknown>;
    delete legacy.savedVacancies;
    delete legacy.vacancyIndex;
    await fsp.writeFile(file, JSON.stringify(legacy), "utf8");

    const store = new FileStateStore({ filePath: file, logger: silentLogger });
    const state = await store.get();

    expect(state.savedVacancies).toEqual({ entries: [], nextId: 1 });
    expect(state.vacancyIndex).toEqual({ items: [] });

    // It is immediately writable, as a real upgrade would be.
    await store.update((draft) => {
      draft.savedVacancies.entries.push({
        id: 1,
        chatId: 42,
        key: "url:https://example.com/apply/1",
        keys: ["url:https://example.com/apply/1"],
        vacancy: makeVacancy(),
        savedAt: "2026-01-01T00:00:00.000Z",
      });
    });
    expect((await store.get()).savedVacancies.entries).toHaveLength(1);
  });

  it("serialises concurrent updates so no write is lost", async () => {
    const file = await tempFile();
    const store = new FileStateStore({ filePath: file, logger: silentLogger });

    const writes = Array.from({ length: 25 }, (_, index) =>
      store.update((draft) => {
        draft.notifications.history.push({
          at: `run-${index}`,
          discovered: 0,
          queued: 0,
          delivered: 0,
          failed: 0,
          summarised: 0,
        });
      }),
    );
    await Promise.all(writes);

    const state = await store.get();
    expect(state.notifications.history).toHaveLength(25);
    expect(state.notifications.history[0]?.at).toBe("run-0");
    expect(state.notifications.history[24]?.at).toBe("run-24");
  });

  it("keeps the queue alive after a rejected update", async () => {
    const file = await tempFile();
    const store = new FileStateStore({ filePath: file, logger: silentLogger });

    await expect(
      store.update((draft) => {
        (draft as { version: unknown }).version = 999;
      }),
    ).rejects.toThrow();

    await store.update((draft) => {
      draft.schedule.settings.time = "06:15";
    });
    const state = await store.get();
    expect(state.schedule.settings.time).toBe("06:15");
  });

  it("returns immutable snapshots to callers", async () => {
    const file = await tempFile();
    const store = new FileStateStore({ filePath: file, logger: silentLogger });
    const first = await store.get();
    first.schedule.settings.time = "07:07";
    const second = await store.get();
    expect(second.schedule.settings.time).toBe(DEFAULT_SCHEDULE_TIME);
  });
});