import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { startHandler } from "../../src/bot/handlers/start.js";
import { helpHandler } from "../../src/bot/handlers/help.js";
import { buildSearchReply, searchHandler } from "../../src/bot/handlers/search.js";
import { createStatusHandler } from "../../src/bot/handlers/status.js";
import type { JobSearchResult, JobSearchStats } from "../../src/services/jobSearch.js";
import type { Vacancy } from "../../src/models/vacancy.js";
import { HELP_MESSAGE, START_MESSAGE } from "../../src/messages.js";

function makeCtx(): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async () => undefined);
  return { ctx: { reply } as unknown as Context, reply };
}

const config = { telegramBotToken: "123456:TESTTOKEN", allowedUserId: 987654321 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeStats(overrides: Partial<JobSearchStats> = {}): JobSearchStats {
  return {
    fetched: 0,
    parsed: 0,
    excludedInvalid: 0,
    excludedClosed: 0,
    excludedUnclear: 0,
    excludedNotOffered: 0,
    excludedDuplicates: 0,
    excludedTpp: 0,
    returned: 0,
    ...overrides,
  };
}

function makeVacancy(): Vacancy {
  return {
    id: "job-1",
    title: "Graduate Software Developer",
    employer: "Acme Ltd",
    location: "Sheffield",
    source: "test-source",
    sourceUrl: "https://example.com/jobs/1",
    applicationUrl: "https://example.com/apply/1",
    vacancySponsorshipStatus: "confirmed",
    sponsorshipEvidence: "We will sponsor a Skilled Worker visa.",
    employerSponsorLicence: "yes",
    employerLicenceEvidence: "Employer mentions licence: sponsor licence",
    lastVerifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeResult(overrides: Partial<JobSearchResult> = {}): JobSearchResult {
  return {
    vacancies: [],
    stats: makeStats(),
    errors: [],
    ...overrides,
  };
}

describe("command handlers", () => {
  it("/start replies with the introduction", async () => {
    const { ctx, reply } = makeCtx();
    await startHandler(ctx);
    expect(reply).toHaveBeenCalledWith(START_MESSAGE);
  });

  it("/help replies with the command list", async () => {
    const { ctx, reply } = makeCtx();
    await helpHandler(ctx);
    expect(reply).toHaveBeenCalledWith(HELP_MESSAGE);
  });

  it("/search reports when no sources yield listings", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobs: [] }),
    }));
    const { ctx, reply } = makeCtx();

    await searchHandler(ctx);

    expect(reply).toHaveBeenCalledOnce();
    const firstCall = reply.mock.calls[0];
    expect(String(firstCall?.[0])).toContain("No job listings were found");
    expect(firstCall?.[1]).toEqual({ parse_mode: "MarkdownV2" });
  });

  it("/status reports online state and the authorised user", async () => {
    const { ctx, reply } = makeCtx();
    await createStatusHandler(config)(ctx);
    const message = String(reply.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("online");
    expect(message).toContain(String(config.allowedUserId));
  });
});

describe("buildSearchReply", () => {
  it("reports confirmed vacancies", () => {
    const result = makeResult({
      vacancies: [makeVacancy()],
      stats: makeStats({ fetched: 1, parsed: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("confirmed sponsorship vacancy");
    expect(reply).toContain("Acme Ltd");
  });

  it("distinguishes listings found without explicit sponsorship", () => {
    const result = makeResult({
      stats: makeStats({ fetched: 3, parsed: 3, excludedUnclear: 3 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("none had explicit sponsorship evidence");
    expect(reply).toContain("unclear\\=3");
  });

  it("distinguishes no listings found by the sources", () => {
    const reply = buildSearchReply(makeResult());

    expect(reply).toContain("No job listings were found");
  });

  it("distinguishes unavailable or failed sources", () => {
    const result = makeResult({ errors: ["reed: request timed out"] });

    const reply = buildSearchReply(result);

    expect(reply).toContain("Could not reach any job sources");
  });
});
