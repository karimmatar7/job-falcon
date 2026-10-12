import { describe, expect, it, vi } from "vitest";
import {
  Notifier,
  isPermanentSendError,
} from "../../src/services/scheduling/notifications.js";
import {
  InMemoryStateStore,
  createInitialState,
  MAX_NOTIFICATION_HISTORY,
  MAX_PENDING_NOTIFICATIONS,
  MAX_SEEN_JOBS,
} from "../../src/services/state/stateStore.js";
import type { PendingNotification, StateStore } from "../../src/services/state/stateStore.js";
import { identityKey, jobIdentityKeys } from "../../src/services/scheduling/jobIdentity.js";
import { makeVacancy, silentLogger } from "../testKit.js";
import type { Vacancy } from "../../src/models/vacancy.js";
import type { NotificationSender } from "../../src/services/scheduling/notifications.js";

const NOW = new Date("2026-06-01T09:00:00.000Z");

function alternative(overrides: Partial<Vacancy> = {}): Vacancy {
  return makeVacancy({
    id: "alt-1",
    vacancySponsorshipStatus: "unclear",
    sponsorshipEvidence: "No explicit sponsorship evidence.",
    employerSponsorLicence: "unknown",
    employerLicenceEvidence: "No licence mentioned.",
    locationEligibility: "eligible",
    matchScore: 60,
    ...overrides,
  });
}

function makeNotifier(options: {
  store?: StateStore;
  sender?: ReturnType<typeof vi.fn>;
  maxAttempts?: number;
  onDelivered?: (info: {
    chatId: number;
    messageId: number;
    vacancies: readonly Vacancy[];
  }) => void | Promise<void>;
} = {}) {
  const store = options.store ?? new InMemoryStateStore();
  const sender = options.sender ?? vi.fn(async () => 1);
  const notifier = new Notifier({
    store,
    sender: sender as unknown as NotificationSender,
    logger: silentLogger,
    now: () => NOW,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.onDelivered === undefined ? {} : { onDelivered: options.onDelivered }),
  });
  return { notifier, store, sender };
}

function pendingSeed(vacancy: Vacancy, overrides: Partial<PendingNotification> = {}): PendingNotification {
  return {
    key: identityKey(vacancy),
    keys: jobIdentityKeys(vacancy),
    chatId: 42,
    vacancy,
    attempts: 0,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("selectNew", () => {
  it("excludes vacancies that explicitly do not offer sponsorship", async () => {
    const { notifier } = makeNotifier();
    const selected = await notifier.selectNew(
      [makeVacancy({ vacancySponsorshipStatus: "not_offered" })],
      25,
    );
    expect(selected).toEqual([]);
  });

  it("excludes unconfirmed vacancies with no UK eligibility", async () => {
    const { notifier } = makeNotifier();
    const selected = await notifier.selectNew(
      [alternative({ locationEligibility: "ineligible" })],
      25,
    );
    expect(selected).toEqual([]);
  });

  it("excludes unconfirmed vacancies below the alternative score floor", async () => {
    const { notifier } = makeNotifier();
    const selected = await notifier.selectNew([alternative({ matchScore: 24 })], 25);
    expect(selected).toEqual([]);
  });

  it("keeps unconfirmed vacancies above the floor", async () => {
    const { notifier } = makeNotifier();
    const selected = await notifier.selectNew([alternative()], 25);
    expect(selected).toHaveLength(1);
  });

  it("keeps confirmed vacancies regardless of score or location", async () => {
    const { notifier } = makeNotifier();
    const selected = await notifier.selectNew(
      [makeVacancy({ locationEligibility: "ineligible", matchScore: 1 })],
      25,
    );
    expect(selected).toHaveLength(1);
  });

  it("sorts confirmed vacancies first, then by score", async () => {
    const { notifier } = makeNotifier();
    const selected = await notifier.selectNew(
      [
        alternative({ id: "a1", matchScore: 90 }),
        makeVacancy({ id: "c1", matchScore: 30 }),
        alternative({ id: "a2", matchScore: 40 }),
        makeVacancy({ id: "c2", matchScore: 95 }),
      ],
      25,
    );
    expect(selected.map((job) => job.id)).toEqual(["c2", "c1", "a1", "a2"]);
  });

  it("deduplicates against the seen set", async () => {
    const { notifier } = makeNotifier();
    const job = makeVacancy();
    await notifier.enqueue([job], 42);
    const selected = await notifier.selectNew([job], 25);
    expect(selected).toEqual([]);
  });

  it("never alerts the same role again from a second source", async () => {
    const { notifier } = makeNotifier();
    const adzuna = makeVacancy({
      source: "adzuna",
      id: "ad-1",
      employer: "Acme Ltd",
      title: "Software Engineer",
      location: "London",
      sourceUrl: "https://adzuna.example/1",
      applicationUrl: "https://adzuna.example/apply/1",
    });
    const remotive = makeVacancy({
      source: "remotive",
      id: "rm-1",
      employer: "Acme Ltd",
      title: "Software Engineer",
      location: "London",
      sourceUrl: "https://remotive.example/1",
      applicationUrl: "https://remotive.example/apply/1",
    });
    expect(identityKey(adzuna)).toBe(identityKey(remotive));

    await notifier.enqueue([adzuna], 42);
    const secondLook = await notifier.selectNew([remotive], 25);
    expect(secondLook).toEqual([]);
  });
});

describe("enqueue", () => {
  it("persists seen keys and a pending entry before anything is sent", async () => {
    const { notifier, store, sender } = makeNotifier();
    const a = makeVacancy();
    const b = makeVacancy({
      id: "job-2",
      title: "Frontend Developer",
      employer: "Beta Ltd",
      location: "Manchester",
      sourceUrl: "https://example.com/jobs/2",
      applicationUrl: "https://example.com/apply/2",
    });

    const result = await notifier.enqueue([a, b], 42);

    expect(result).toEqual({ queued: 2, seenKeys: 8 });
    expect(sender).not.toHaveBeenCalled();

    const state = await store.get();
    const seen = state.notifications.seen;
    expect(Object.keys(seen)).toHaveLength(8);
    expect(seen[identityKey(a)]).toEqual({
      firstSeenAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
      status: "seen",
    });
    expect(state.notifications.pending).toHaveLength(2);
    expect(state.notifications.pending[0]).toMatchObject({
      key: identityKey(a),
      chatId: 42,
      attempts: 0,
      createdAt: NOW.toISOString(),
    });
  });

  it("is a no-op for an empty list", async () => {
    const { notifier, store, sender } = makeNotifier();
    const result = await notifier.enqueue([], 42);
    expect(result).toEqual({ queued: 0, seenKeys: 0 });
    const state = await store.get();
    expect(state.notifications.pending).toHaveLength(0);
    expect(sender).not.toHaveBeenCalled();
  });
});

describe("deliverPending", () => {
  it("delivers a queued notification and marks its keys notified", async () => {
    const sender = vi.fn(async () => 99);
    const { notifier, store } = makeNotifier({ sender });
    const job = makeVacancy();
    await notifier.enqueue([job], 42);

    const result = await notifier.deliverPending(10);

    expect(result).toEqual({ delivered: 1, failed: 0, dropped: 0, remaining: 0 });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith({
      chatId: 42,
      text: expect.stringContaining("CONFIRMED sponsorship"),
      parseMode: "MarkdownV2",
    });
    const state = await store.get();
    expect(state.notifications.pending).toHaveLength(0);
    expect(state.notifications.seen[identityKey(job)]?.status).toBe("notified");
    expect(state.notifications.seen[identityKey(job)]?.notifiedAt).toBe(NOW.toISOString());
  });

  it("retries a failed send without marking it delivered", async () => {
    const sender = vi.fn(async () => 1);
    sender
      .mockRejectedValueOnce(new Error("telegram: 500 internal"))
      .mockResolvedValueOnce(7);
    const { notifier, store } = makeNotifier({ sender });
    await notifier.enqueue([makeVacancy()], 42);

    const first = await notifier.deliverPending(10);
    expect(first).toEqual({ delivered: 0, failed: 1, dropped: 0, remaining: 1 });

    let state = await store.get();
    expect(state.notifications.pending).toHaveLength(1);
    expect(state.notifications.pending[0]?.attempts).toBe(1);
    expect(state.notifications.pending[0]?.lastAttemptAt).toBe(NOW.toISOString());
    expect(state.notifications.pending[0]?.lastError).toContain("500");

    const second = await notifier.deliverPending(10);
    expect(second).toEqual({ delivered: 1, failed: 0, dropped: 0, remaining: 0 });
    state = await store.get();
    expect(state.notifications.pending).toHaveLength(0);
  });

  it("drops a send that fails permanently", async () => {
    const sender = vi.fn(async () => {
      throw new Error("telegram: 400 Bad Request: chat not found");
    });
    const { notifier, store } = makeNotifier({ sender });
    await notifier.enqueue([makeVacancy()], 42);

    const result = await notifier.deliverPending(10);

    expect(result).toEqual({ delivered: 0, failed: 0, dropped: 1, remaining: 0 });
    const state = await store.get();
    expect(state.notifications.pending).toHaveLength(0);
    expect(state.notifications.seen[identityKey(makeVacancy())]?.status).toBe("dropped");
  });

  it("drops once the attempt budget is exhausted", async () => {
    const sender = vi.fn(async () => {
      throw new Error("telegram: 500 again");
    });
    const { notifier, store } = makeNotifier({ sender, maxAttempts: 2 });
    await notifier.enqueue([makeVacancy()], 42);

    const first = await notifier.deliverPending(10);
    expect(first).toEqual({ delivered: 0, failed: 1, dropped: 0, remaining: 1 });

    const second = await notifier.deliverPending(10);
    expect(second).toEqual({ delivered: 0, failed: 0, dropped: 1, remaining: 0 });
    expect((await store.get()).notifications.pending).toHaveLength(0);
  });

  it("drops a resumed pending entry that already spent its budget", async () => {
    const sender = vi.fn(async () => {
      throw new Error("telegram: 500 x");
    });
    const { notifier, store } = makeNotifier({ sender, maxAttempts: 5 });
    const job = makeVacancy();
    await notifier.enqueue([job], 42);
    await store.update((draft) => {
      const entry = draft.notifications.pending.find((item) => item.key === identityKey(job));
      if (entry !== undefined) entry.attempts = 4;
    });

    const result = await notifier.deliverPending(10);
    expect(result.dropped).toBe(1);
    expect(result.failed).toBe(0);
    expect((await store.get()).notifications.pending).toHaveLength(0);
  });

  it("respects the per-run limit", async () => {
    const { notifier } = makeNotifier();
    const jobs = [
      makeVacancy({ id: "j1", title: "Software Engineer", applicationUrl: "https://example.com/apply/1" }),
      makeVacancy({ id: "j2", title: "Frontend Developer", applicationUrl: "https://example.com/apply/2" }),
      makeVacancy({ id: "j3", title: "Data Analyst", applicationUrl: "https://example.com/apply/3" }),
    ];
    await notifier.enqueue(jobs, 42);

    const result = await notifier.deliverPending(2);

    expect(result).toEqual({ delivered: 2, failed: 0, dropped: 0, remaining: 1 });
  });

  it("returns zeroes for a non-positive limit", async () => {
    const { notifier } = makeNotifier();
    await notifier.enqueue([makeVacancy()], 42);
    const result = await notifier.deliverPending(0);
    expect(result).toEqual({ delivered: 0, failed: 0, dropped: 0, remaining: 1 });
  });

  it("reports a delivered vacancy message so /save can resolve it", async () => {
    const onDelivered = vi.fn();
    const sender = vi.fn(async () => 99);
    const { notifier } = makeNotifier({ sender, onDelivered });
    const job = makeVacancy();
    await notifier.enqueue([job], 42);

    await notifier.deliverPending(10);

    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onDelivered).toHaveBeenCalledWith({
      chatId: 42,
      messageId: 99,
      vacancies: [job],
    });
  });

  it("still delivers when the /save index callback throws", async () => {
    const onDelivered = vi.fn(async () => {
      throw new Error("index boom");
    });
    const sender = vi.fn(async () => 5);
    const { notifier, store } = makeNotifier({ sender, onDelivered });
    await notifier.enqueue([makeVacancy()], 42);

    const result = await notifier.deliverPending(10);

    expect(result).toEqual({ delivered: 1, failed: 0, dropped: 0, remaining: 0 });
    expect((await store.get()).notifications.pending).toHaveLength(0);
  });
});

describe("buildMessage", () => {
  it("labels confirmed sponsorship explicitly", () => {
    const { notifier } = makeNotifier();
    const message = notifier.buildMessage(makeVacancy());
    expect(message).toContain("New job with CONFIRMED sponsorship");
  });

  it("labels unconfirmed sponsorship clearly", () => {
    const { notifier } = makeNotifier();
    const message = notifier.buildMessage(alternative());
    expect(message).toContain("sponsorship unconfirmed");
  });

  it("never lets a licensed employer imply vacancy sponsorship", () => {
    const { notifier } = makeNotifier();
    const message = notifier.buildMessage(
      alternative({ employerRegisterStatus: "verified", employerSponsorshipVerified: true }),
    );
    expect(message).toContain("LICENSED SPONSOR");
    expect(message).toContain("does not confirm sponsorship for this role");
    expect(message).not.toContain("CONFIRMED for this vacancy");
  });
});

describe("markSeen / sendSummary / recordHistory", () => {
  it("marks extra matches as seen with a summarised status", async () => {
    const { notifier, store } = makeNotifier();
    const job = alternative();
    await notifier.markSeen([job], "summarised");
    const state = await store.get();
    expect(state.notifications.seen[identityKey(job)]?.status).toBe("summarised");
  });

  it("sends nothing for a zero summary", async () => {
    const { notifier, sender } = makeNotifier();
    await notifier.sendSummary(42, 0);
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends a plain-text summary for extra matches", async () => {
    const { notifier, sender } = makeNotifier();
    await notifier.sendSummary(42, 2);
    expect(sender).toHaveBeenCalledWith({
      chatId: 42,
      text: expect.stringContaining("2 more new match(es)"),
    });
    expect(sender.mock.calls[0]?.[0]).not.toHaveProperty("parseMode");
  });

  it("appends history entries and caps the list", async () => {
    const { notifier, store } = makeNotifier();
    for (let index = 0; index < MAX_NOTIFICATION_HISTORY + 1; index++) {
      await notifier.recordHistory({
        at: `2026-06-01T00:0${index}:00.000Z`,
        discovered: index,
        queued: 0,
        delivered: 0,
        failed: 0,
        summarised: 0,
      });
    }
    const history = (await store.get()).notifications.history;
    expect(history).toHaveLength(MAX_NOTIFICATION_HISTORY);
    expect(history[history.length - 1]?.discovered).toBe(MAX_NOTIFICATION_HISTORY);
  });
});

describe("prune", () => {
  it("bounds the seen set, keeping the newest entries", async () => {
    const store = new InMemoryStateStore();
    await store.update((draft) => {
      for (let index = 0; index < MAX_SEEN_JOBS; index++) {
        draft.notifications.seen[`seed-${index}`] = {
          firstSeenAt: "2020-01-01T00:00:00.000Z",
          lastSeenAt: "2020-01-01T00:00:00.000Z",
          status: "seen",
        };
      }
    });
    const { notifier } = makeNotifier({ store });
    const fresh = alternative();
    await notifier.markSeen([fresh]);

    const state = await store.get();
    const seenKeys = Object.keys(state.notifications.seen);
    expect(seenKeys).toHaveLength(MAX_SEEN_JOBS);
    expect(state.notifications.seen[identityKey(fresh)]).toBeDefined();
  });

  it("bounds the pending queue, dropping the oldest entries", async () => {
    const store = new InMemoryStateStore();
    const seed = (index: number) =>
      makeVacancy({
        id: `seed-${index}`,
        employer: `Seed Corp ${index}`,
        title: `Role ${index}`,
        location: `City ${index}`,
        applicationUrl: `https://example.com/apply/seed-${index}`,
      });
    await store.update((draft) => {
      for (let index = 0; index < MAX_PENDING_NOTIFICATIONS; index++) {
        draft.notifications.pending.push(pendingSeed(seed(index)));
      }
    });

    const fresh = makeVacancy({
      id: "brand-new",
      employer: "Brand New Ltd",
      title: "New Role",
      location: "Newcastle",
      applicationUrl: "https://example.com/apply/brand-new",
    });
    const { notifier } = makeNotifier({ store });
    await notifier.enqueue([fresh], 42);

    const state = await store.get();
    expect(state.notifications.pending).toHaveLength(MAX_PENDING_NOTIFICATIONS);
    // The brand-new entry survives; the oldest seeded entries overflowed.
    expect(
      state.notifications.pending.some((entry) => entry.key === identityKey(fresh)),
    ).toBe(true);
    expect(
      state.notifications.pending.some((entry) => entry.key === identityKey(seed(0))),
    ).toBe(false);
    expect(
      state.notifications.pending.some((entry) => entry.key === identityKey(seed(1))),
    ).toBe(true);
  });
});

describe("isPermanentSendError", () => {
  it("recognises errors Telegram will never recover from", () => {
    expect(isPermanentSendError("chat not found")).toBe(true);
    expect(isPermanentSendError("bot was blocked by the user")).toBe(true);
    expect(isPermanentSendError("user is deactivated")).toBe(true);
    expect(isPermanentSendError("bot can't initiate conversation with a user")).toBe(true);
    expect(isPermanentSendError("can't parse entities")).toBe(true);
    expect(isPermanentSendError("message text is empty")).toBe(true);
  });

  it("treats transient errors as retryable", () => {
    expect(isPermanentSendError("telegram: 500 internal server error")).toBe(false);
    expect(isPermanentSendError("telegram: 429 Too Many Requests: retry after 5")).toBe(false);
    expect(isPermanentSendError("network timeout")).toBe(false);
  });
});