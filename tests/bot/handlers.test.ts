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

function makeSearchCtx(text: string): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async () => undefined);
  return { ctx: { message: { text }, reply } as unknown as Context, reply };
}

const config = { telegramBotToken: "123456:TESTTOKEN", allowedUserId: 987654321 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function makeStats(overrides: Partial<JobSearchStats> = {}): JobSearchStats {
  return {
    fetched: 0,
    parsed: 0,
    excludedInvalid: 0,
    excludedClosed: 0,
    excludedPaidTraining: 0,
    excludedSenior: 0,
    excludedIneligibleLocation: 0,
    excludedNotOffered: 0,
    excludedDuplicates: 0,
    excludedTpp: 0,
    excludedUnclear: 0,
    excludedLowRelevance: 0,
    confirmed: 0,
    excludedConfirmedOverLimit: 0,
    employerVerifiedAlternatives: 0,
    alternatives: 0,
    returned: 0,
    sources: [],
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

  it("/search with keywords and a location forwards them to the sources", async () => {
    const urls: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("ADZUNA_APP_ID", "test-app-id");
    vi.stubEnv("ADZUNA_APP_KEY", "test-app-key");
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jobs: [], results: [] }),
      };
    });
    const { ctx, reply } = makeSearchCtx("/search software developer leeds");

    await searchHandler(ctx);

    const adzunaUrl = urls.find((url) => url.includes("api.adzuna.com"));
    expect(adzunaUrl).toBeDefined();
    expect(adzunaUrl).toContain("what=software+developer");
    expect(adzunaUrl).toContain("where=leeds");
    expect(reply).toHaveBeenCalledOnce();
  });

  it("/search with no arguments still performs a default search", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
    });
    const { ctx, reply } = makeSearchCtx("/search");

    await searchHandler(ctx);

    expect(urls.length).toBeGreaterThan(0);
    expect(reply).toHaveBeenCalledOnce();
  });

  it("/search with an invalid limit replies with usage instead of searching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { ctx, reply } = makeSearchCtx("/search 0");

    await searchHandler(ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(reply.mock.calls[0]?.[0])).toContain("Usage: /search");
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
      stats: makeStats({ fetched: 3, parsed: 3, excludedUnclear: 1, excludedLowRelevance: 0, alternatives: 2, returned: 2 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("No vacancies with confirmed sponsorship were found");
    expect(reply).toContain("ask the employer");
    expect(reply).toContain("UNCONFIRMED");
    expect(reply).toContain("OTHER RELEVANT OPPORTUNITIES");
    expect(reply).toContain("Beta Ltd");
    expect(reply).toContain("over\\_cap\\=1");
    expect(reply).toContain("low\\_relevance\\=0");
  });

  it("reports low-relevance drops so the coverage note reconciles", () => {
    const result = makeResult({
      stats: makeStats({ fetched: 10, parsed: 10, excludedUnclear: 3, excludedLowRelevance: 4 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("over\\_cap\\=3");
    expect(reply).toContain("low\\_relevance\\=4");
  });

  it("reports senior-role exclusions in the coverage note", () => {
    const result = makeResult({
      stats: makeStats({ fetched: 5, parsed: 5, excludedSenior: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("senior\\=1");
  });

  it("reports confirmed vacancies dropped by the result limit in the coverage note", () => {
    const result = makeResult({
      vacancies: Array.from({ length: 5 }, () => makeVacancy()),
      stats: makeStats({ fetched: 7, parsed: 7, confirmed: 5, excludedConfirmedOverLimit: 2, returned: 5 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("confirmed\\_over\\_limit\\=2");
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

  it("reports called, zero-result, skipped and failed sources distinctly", () => {
    const result = makeResult({
      stats: makeStats({
        fetched: 10,
        sources: [
          { name: "remotive", status: "ok", fetched: 10, parsed: 10 },
          { name: "adzuna", status: "ok", fetched: 0, parsed: 0 },
          { name: "reed", status: "failed", fetched: 0, parsed: 0, error: "timeout" },
          { name: "dummy", status: "disabled", fetched: 0, parsed: 0 },
        ],
      }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("remotive 10/10");
    expect(reply).toContain("adzuna 0 results");
    expect(reply).toContain("reed FAILED");
    expect(reply).toContain("dummy skipped");
  });
});

describe("buildSearchReply application links", () => {
  it("shows a valid direct application URL", () => {
    const result = makeResult({
      vacancies: [makeAlternative()],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("Apply: https://example\\.com/apply/alt\\-1");
  });

  it("marks the apply link unavailable instead of showing a source homepage", () => {
    const result = makeResult({
      vacancies: [makeAlternative({ applicationUrl: "https://www.adzuna.co.uk/" })],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("link unavailable");
    expect(reply).not.toContain("www.adzuna.co.uk");
  });

  it("marks the apply link unavailable when no listing URL exists", () => {
    const withoutUrl = makeAlternative();
    delete withoutUrl.applicationUrl;
    const result = makeResult({
      vacancies: [withoutUrl],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("link unavailable");
  });

  it("reports paid-training exclusions in the coverage note", () => {
    const result = makeResult({
      stats: makeStats({ fetched: 6, parsed: 6, excludedPaidTraining: 2 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("paid\\_training\\=2");
  });
});

describe("buildSearchReply employer register line", () => {
  it("shows a verified sponsor with the register update date, never as confirmed sponsorship", () => {
    const result = makeResult({
      vacancies: [
        makeAlternative({
          employerRegisterStatus: "verified",
          employerSponsorshipVerified: true,
          employerVerificationTarget: "Beta Ltd",
          sponsorRegisterUpdatedAt: "2026-10-09",
        }),
      ],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("Employer register");
    expect(reply).toContain("LICENSED SPONSOR");
    expect(reply).toContain("register updated");
    expect(reply).toContain("2026");
    expect(reply).not.toContain("confirmed sponsorship vacancy");
  });

  it("shows not_found without claiming the employer is unlicensed", () => {
    const result = makeResult({
      vacancies: [makeAlternative({ employerRegisterStatus: "not_found" })],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("Employer register");
    expect(reply).toContain("no exact match");
    expect(reply).toContain("does NOT prove the employer is unlicensed");
  });

  it("shows unavailable without implying a negative result", () => {
    const result = makeResult({
      vacancies: [makeAlternative({ employerRegisterStatus: "unavailable" })],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("Employer register");
    expect(reply).toContain("could not be checked");
  });

  it("shows not_checked for a recruiter vacancy with an unidentified employer", () => {
    const result = makeResult({
      vacancies: [
        makeAlternative({ employerRegisterStatus: "not_checked", employerType: "recruiter" }),
      ],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("Employer register");
    expect(reply).toContain("advertised by a recruitment agency");
    expect(reply).not.toContain("LICENSED SPONSOR");
  });

  it("omits the register line for legacy data with no register outcome", () => {
    const result = makeResult({
      vacancies: [makeAlternative()],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).not.toContain("Employer register");
  });

  it("derives a verified line from the legacy verified flag", () => {
    const result = makeResult({
      vacancies: [makeAlternative({ employerSponsorshipVerified: true })],
      stats: makeStats({ fetched: 1, parsed: 1, alternatives: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("LICENSED SPONSOR");
  });

  it("keeps a verified employer independent from a confirmed vacancy", () => {
    const result = makeResult({
      vacancies: [
        {
          ...makeVacancy(),
          employerRegisterStatus: "verified",
          employerSponsorshipVerified: true,
        },
      ],
      stats: makeStats({ fetched: 1, parsed: 1, confirmed: 1, returned: 1 }),
    });

    const reply = buildSearchReply(result);

    expect(reply).toContain("LICENSED SPONSOR");
    expect(reply).toContain("CONFIRMED SPONSORSHIP");
  });
});
