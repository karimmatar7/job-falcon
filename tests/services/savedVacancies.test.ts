import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SavedVacancyService } from "../../src/services/savedVacancies.js";
import {
  FileStateStore,
  InMemoryStateStore,
} from "../../src/services/state/stateStore.js";
import type { Vacancy } from "../../src/models/vacancy.js";
import { makeVacancy, silentLogger } from "../testKit.js";

const NOW = new Date("2026-06-01T09:00:00.000Z");
const CHAT = 42;

const cleanup: string[] = [];

afterEach(async () => {
  const dirs = cleanup.splice(0);
  await Promise.all(dirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function vacancy(n: number): Vacancy {
  return makeVacancy({
    id: `job-${n}`,
    title: `Role ${n}`,
    employer: `Employer ${n} Ltd`,
    location: `City ${n}`,
    sourceUrl: `https://example.com/jobs/${n}`,
    applicationUrl: `https://example.com/apply/${n}`,
  });
}

function makeService(store = new InMemoryStateStore()) {
  return { store, service: new SavedVacancyService({ store, now: () => NOW }) };
}

describe("SavedVacancyService", () => {
  it("records delivered vacancy messages grouped by message, most recent first", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 10, [vacancy(1)]);
    await service.recordDelivered(CHAT, 11, [vacancy(2), vacancy(3)]);

    const groups = await service.recentGroups(CHAT);
    expect(groups.map((group) => group.messageId)).toEqual([11, 10]);
    expect(groups[0]?.vacancies.map((v) => v.id)).toEqual(["job-2", "job-3"]);
    expect(groups[0]?.at).toBe(NOW.toISOString());
  });

  it("keeps chats separate", async () => {
    const { service } = makeService();
    await service.recordDelivered(1, 10, [vacancy(1)]);
    expect(await service.recentGroups(2)).toEqual([]);
  });

  it("re-recording the same message replaces its entries instead of duplicating", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 10, [vacancy(1)]);
    await service.recordDelivered(CHAT, 10, [vacancy(2)]);

    const groups = await service.recentGroups(CHAT);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.vacancies.map((v) => v.id)).toEqual(["job-2"]);
  });

  it("saves the vacancy from the most recent single-vacancy message and its message id", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 100, [vacancy(1)]);

    const outcome = await service.save(CHAT);

    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("expected saved");
    expect(outcome.entry.id).toBe(1);
    expect(outcome.entry.chatId).toBe(CHAT);
    expect(outcome.entry.messageId).toBe(100);
    expect(outcome.entry.savedAt).toBe(NOW.toISOString());
    expect(outcome.entry.vacancy.id).toBe("job-1");
    expect(outcome.entry.keys.length).toBeGreaterThan(0);
  });

  it("reports no_recent_vacancy when nothing was delivered", async () => {
    const { service } = makeService();
    expect((await service.save(CHAT)).status).toBe("no_recent_vacancy");
  });

  it("deduplicates a vacancy already saved", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 100, [vacancy(1)]);
    await service.save(CHAT);

    await service.recordDelivered(CHAT, 200, [vacancy(1)]);
    const again = await service.save(CHAT);

    expect(again.status).toBe("already_saved");
    expect(await service.listSaved(CHAT)).toHaveLength(1);
  });

  it("keeps the original message association when the same vacancy reappears", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 100, [vacancy(1)]);
    const first = await service.save(CHAT);
    if (first.status !== "saved") throw new Error("expected saved");

    // Replay the same vacancy from a later message; it must not create a second
    // record, and must keep the original association.
    await service.recordDelivered(CHAT, 101, [vacancy(1)]);
    const second = await service.save(CHAT);
    expect(second.status).toBe("already_saved");
    if (second.status !== "already_saved") throw new Error("expected already_saved");
    expect(second.entry.messageId).toBe(100);
    expect(await service.listSaved(CHAT)).toHaveLength(1);
  });

  it("saves several vacancies from separate messages", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 1, [vacancy(1)]);
    await service.save(CHAT);
    await service.recordDelivered(CHAT, 2, [vacancy(2)]);
    await service.save(CHAT);
    await service.recordDelivered(CHAT, 3, [vacancy(3)]);
    await service.save(CHAT);

    const saved = await service.listSaved(CHAT);
    expect(saved).toHaveLength(3);
    expect(saved.map((entry) => entry.id)).toEqual([3, 2, 1]);
    expect(saved.map((entry) => entry.messageId)).toEqual([3, 2, 1]);
  });

  it("asks for a choice when the most recent message carries several vacancies", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 9, [vacancy(1), vacancy(2), vacancy(3)]);

    const outcome = await service.save(CHAT);

    expect(outcome.status).toBe("selection_required");
    if (outcome.status !== "selection_required") throw new Error("expected selection");
    expect(outcome.messageId).toBe(9);
    expect(outcome.vacancies.map((v) => v.id)).toEqual(["job-1", "job-2", "job-3"]);
  });

  it("saves the chosen vacancy when given an index", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 9, [vacancy(1), vacancy(2), vacancy(3)]);

    const outcome = await service.save(CHAT, { index: 2 });

    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("expected saved");
    expect(outcome.entry.vacancy.id).toBe("job-2");
    expect(outcome.entry.messageId).toBe(9);
  });

  it("rejects an out-of-range selection", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 9, [vacancy(1), vacancy(2)]);

    const outcome = await service.save(CHAT, { index: 5 });

    expect(outcome.status).toBe("invalid_selection");
    if (outcome.status !== "invalid_selection") throw new Error("expected invalid");
    expect(outcome.count).toBe(2);
  });

  it("saves from the replied-to message rather than the most recent one", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 1, [vacancy(1)]);
    await service.recordDelivered(CHAT, 2, [vacancy(2)]);

    const outcome = await service.save(CHAT, { replyToMessageId: 1 });

    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("expected saved");
    expect(outcome.entry.messageId).toBe(1);
    expect(outcome.entry.vacancy.id).toBe("job-1");
  });

  it("returns no_recent_vacancy when replying to an unknown message", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 1, [vacancy(1)]);
    expect((await service.save(CHAT, { replyToMessageId: 999 })).status).toBe(
      "no_recent_vacancy",
    );
  });

  it("reports the saved message ids that /empty must protect", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 100, [vacancy(1)]);
    await service.recordDelivered(CHAT, 200, [vacancy(2)]);
    await service.save(CHAT, { replyToMessageId: 100 });

    expect(await service.savedMessageIds(CHAT)).toEqual(new Set([100]));
    expect(await service.savedMessageIds(7)).toEqual(new Set());
  });

  it("prunes the index entries for messages that are not kept", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 100, [vacancy(1)]);
    await service.save(CHAT); // saved at message 100
    await service.recordDelivered(CHAT, 200, [vacancy(2)]); // unprotected

    await service.pruneRefs(CHAT, new Set([100]));

    const groups = await service.recentGroups(CHAT);
    expect(groups.map((group) => group.messageId)).toEqual([100]);
  });

  it("leaves other chats untouched when pruning", async () => {
    const { service } = makeService();
    await service.recordDelivered(CHAT, 100, [vacancy(1)]);
    await service.recordDelivered(7, 100, [vacancy(2)]);

    await service.pruneRefs(CHAT, new Set());

    expect(await service.recentGroups(7)).toHaveLength(1);
  });

  it("bounds the number of indexed vacancy references", async () => {
    const store = new InMemoryStateStore();
    const service = new SavedVacancyService({ store, now: () => NOW, maxRefs: 3 });
    for (let n = 1; n <= 5; n++) {
      await service.recordDelivered(CHAT, n, [vacancy(n)]);
    }

    const groups = await service.recentGroups(CHAT);
    expect(groups.map((group) => group.messageId)).toEqual([5, 4, 3]);
  });

  it("survives a restart by loading saved vacancies from disk", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "job-scout-saved-"));
    cleanup.push(dir);
    const filePath = path.join(dir, "state.json");

    const first = new FileStateStore({ filePath, logger: silentLogger });
    const firstService = new SavedVacancyService({ store: first, now: () => NOW });
    await firstService.recordDelivered(CHAT, 100, [vacancy(1)]);
    await firstService.save(CHAT);

    // A brand-new store instance reads the same file, as a restart would.
    const second = new FileStateStore({ filePath, logger: silentLogger });
    const secondService = new SavedVacancyService({ store: second, now: () => NOW });

    const saved = await secondService.listSaved(CHAT);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.vacancy.id).toBe("job-1");
    expect(saved[0]?.messageId).toBe(100);
    expect(await secondService.savedMessageIds(CHAT)).toEqual(new Set([100]));
    expect((await secondService.recentGroups(CHAT)).map((g) => g.messageId)).toEqual([100]);
  });
});
