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
    excludedNotOffered: 0,
    excludedDuplicates: 0,
    excludedTpp: 0,
    excludedUnclear: 0,
    confirmed: 0,
    alternatives: 0,
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

function makeAlternative(overrides: Partial<Vacancy> = {}): Vacancy {
  return {
    ...makeVacancy(),
    id: "alt-1",
    title: "Frontend Developer",
    employer: "Beta Ltd",
    location: "UK",
    applicationUrl: "https://example.com/apply/alt-1",
    sourceUrl: "https://example.com/jobs/alt-1",
    vacancySponsorshipStatus: "unclear",
    sponsorshipEvidence: "No explicit sponsorship support found; silence about sponsorship.",
    employerSponsorLicence: "unknown",
    ...overrides,
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
      stats: makeStats({ fetched: 1, parsed: 1, confirmed: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("confirmed sponsorship vacancy");
    expect(reply).toContain("Acme Ltd");
    expect(reply).toContain("CONFIRMED SPONSORSHIP");
  });

  it("shows relevant alternatives with unconfirmed sponsorship when no confirmed exist", () => {
    const result = makeResult({
      vacancies: [makeAlternative(), makeAlternative({ id: "alt-2", applicationUrl: "https://example.com/apply/alt-2" })],
      stats: makeStats({ fetched: 3, parsed: 3, excludedUnclear: 1, alternatives: 2, returned: 2 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("No vacancies with confirmed sponsorship were found");
    expect(reply).toContain("ask the employer");
    expect(reply).toContain("UNCONFIRMED");
    expect(reply).toContain("OTHER RELEVANT OPPORTUNITIES");
    expect(reply).toContain("Beta Ltd");
    expect(reply).toContain("excluded unclear\\=1");
  });

  it("shows confirmed results first and then alternatives", () => {
    const result = makeResult({
      vacancies: [makeVacancy(), makeAlternative()],
      stats: makeStats({ fetched: 2, parsed: 2, confirmed: 1, alternatives: 1, returned: 2 }),
    });

    const reply = buildSearchReply(result);

    const confirmedAt = reply.indexOf("CONFIRMED SPONSORSHIP");
    const alternativesAt = reply.indexOf("OTHER RELEVANT OPPORTUNITIES");
    expect(confirmedAt).toBeGreaterThan(-1);
    expect(alternativesAt).toBeGreaterThan(confirmedAt);
    expect(reply).toContain("Acme Ltd");
    expect(reply).toContain("Beta Ltd");
  });

  it("never labels an alternative as confirmed sponsorship", () => {
    const result = makeResult({
      vacancies: [makeAlternative()],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).not.toContain("confirmed sponsorship vacancy");
    expect(reply).toContain("UNCONFIRMED");
  });

  it("distinguishes no usable listings when the sources found only excluded records", () => {
    const result = makeResult({
      stats: makeStats({ fetched: 2, parsed: 2, excludedNotOffered: 2 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("none were usable");
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
