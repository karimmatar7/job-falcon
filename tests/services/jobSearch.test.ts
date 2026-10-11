import { describe, expect, it } from "vitest";
import type { Vacancy } from "../../src/models/vacancy.js";
import { DEFAULT_KEYWORDS, MAX_ALTERNATIVES, RealJobSearchService } from "../../src/services/jobSearch.js";
import type { JobSource, SourceQuery } from "../../src/services/sources/base.js";
import { createDefaultSources } from "../../src/services/sources/defaults.js";
import { NullSponsorRegister } from "../../src/services/sponsorRegister.js";
import type { SponsorRegister } from "../../src/services/sponsorRegister.js";
import type { Logger } from "../../src/utils/logger.js";

function makeVacancy(overrides: Partial<Vacancy> = {}): Vacancy {
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
    ...overrides,
  };
}

let counter = 0;
function unclearVacancy(overrides: Partial<Vacancy> = {}): Vacancy {
  counter += 1;
  return makeVacancy({
    id: `unclear-${counter}`,
    title: `Unclear Developer ${counter}`,
    employer: `Unclear Co ${counter}`,
    applicationUrl: `https://example.com/apply/unclear-${counter}`,
    sourceUrl: `https://example.com/jobs/unclear-${counter}`,
    vacancySponsorshipStatus: "unclear",
    sponsorshipEvidence: "No explicit sponsorship support found; silence about sponsorship.",
    employerSponsorLicence: "unknown",
    ...overrides,
  });
}

function sourceReturning(listings: readonly Vacancy[], name = "fake"): JobSource {
  return { name, enabled: true, search: async () => [...listings] };
}

function failingSource(message = "network down", name = "broken"): JobSource {
  return {
    name,
    enabled: true,
    search: async () => {
      throw new Error(message);
    },
  };
}

function capturingSource(): { source: JobSource; queries: SourceQuery[] } {
  const queries: SourceQuery[] = [];
  const source: JobSource = {
    name: "capturing",
    enabled: true,
    search: async (query) => {
      queries.push(query);
      return [];
    },
  };
  return { source, queries };
}

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("RealJobSearchService", () => {
  it("returns confirmed vacancies first, then up to five relevant alternatives", async () => {
    const service = new RealJobSearchService(
      [
        sourceReturning([
          makeVacancy({ id: "c1" }),
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
        ]),
      ],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toHaveLength(4);
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(result.vacancies.slice(1).every(v => v.vacancySponsorshipStatus === "unclear")).toBe(
      true,
    );
    expect(result.stats.fetched).toBe(4);
    expect(result.stats.parsed).toBe(4);
    expect(result.stats.confirmed).toBe(1);
    expect(result.stats.alternatives).toBe(3);
    expect(result.stats.excludedUnclear).toBe(0);
    expect(result.stats.returned).toBe(4);
    expect(result.errors).toEqual([]);
  });

  it("returns relevant alternatives when there are zero confirmed results", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy(), unclearVacancy(), unclearVacancy()])],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toHaveLength(3);
    expect(result.vacancies.every(v => v.vacancySponsorshipStatus === "unclear")).toBe(true);
    expect(result.stats.confirmed).toBe(0);
    expect(result.stats.alternatives).toBe(3);
    expect(result.stats.excludedUnclear).toBe(0);
    expect(result.stats.returned).toBe(3);
  });

  it("never counts alternatives as confirmed sponsorship", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy(), unclearVacancy()])],
      silentLogger,
    );

    const result = await service.search();

    expect(result.stats.confirmed).toBe(0);
    expect(result.stats.alternatives).toBe(2);
    expect(result.vacancies.some(v => v.vacancySponsorshipStatus === "confirmed")).toBe(false);
  });

  it("caps total results at the requested limit", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([makeVacancy({ id: "c1" }), unclearVacancy(), unclearVacancy()])],
      silentLogger,
    );

    const result = await service.search({ limit: 1 });

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(result.stats.confirmed).toBe(1);
    expect(result.stats.alternatives).toBe(0);
  });

  it("leaves room for alternatives when confirmed results do not fill the limit", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([makeVacancy({ id: "c1" }), unclearVacancy()])],
      silentLogger,
    );

    const result = await service.search({ limit: 2 });

    expect(result.vacancies).toHaveLength(2);
    expect(result.stats.confirmed).toBe(1);
    expect(result.stats.alternatives).toBe(1);
  });

  it("reports no listings when sources yield nothing", async () => {
    const service = new RealJobSearchService([sourceReturning([])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.fetched).toBe(0);
    expect(result.stats.returned).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("records source failures without throwing", async () => {
    const service = new RealJobSearchService(
      [failingSource("503 Service Unavailable", "reed")],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.fetched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("reed");
    expect(result.errors[0]).toContain("503 Service Unavailable");
  });

  it("keeps working results when the Adzuna source fails", async () => {
    const service = new RealJobSearchService(
      [failingSource("HTTP 401 (authentication failed)", "adzuna"), sourceReturning([unclearVacancy({ source: "remotive" })], "remotive")],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]?.source).toBe("remotive");
    expect(result.stats.sources.find(s => s.name === "adzuna")).toMatchObject({
      status: "failed",
      error: "HTTP 401 (authentication failed)",
    });
    expect(result.stats.sources.find(s => s.name === "remotive")).toMatchObject({
      status: "ok",
      fetched: 1,
      parsed: 1,
    });
  });

  it("excludes listings that explicitly do not offer sponsorship", async () => {
    const notOffered = makeVacancy({
      id: "job-no",
      vacancySponsorshipStatus: "not_offered",
      sponsorshipEvidence: "We are unable to sponsor.",
    });
    const service = new RealJobSearchService([sourceReturning([notOffered])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedNotOffered).toBe(1);
    expect(result.stats.confirmed).toBe(0);
    expect(result.stats.alternatives).toBe(0);
  });

  it("deduplicates listings sharing an application URL", async () => {
    const first = makeVacancy({ id: "job-a" });
    const second = makeVacancy({ id: "job-b", title: "Software Developer" });
    const service = new RealJobSearchService([sourceReturning([first, second])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toHaveLength(1);
    expect(result.stats.excludedDuplicates).toBe(1);
  });

  it("prefers a confirmed listing over an unclear duplicate of the same vacancy", async () => {
    const confirmed = makeVacancy({ id: "confirmed" });
    const duplicateUnclear = unclearVacancy({
      applicationUrl: "https://example.com/apply/1",
      sourceUrl: "https://example.com/jobs/1",
      employer: "Acme Ltd",
      title: "Graduate Software Developer",
    });
    const service = new RealJobSearchService(
      [sourceReturning([confirmed, duplicateUnclear])],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(result.stats.excludedDuplicates).toBe(1);
    expect(result.stats.alternatives).toBe(0);
  });

  it("excludes TPP graduate roles in Leeds", async () => {
    const tpp = makeVacancy({
      id: "job-tpp",
      employer: "TPP",
      title: "Graduate Software Developer",
      location: "Leeds",
    });
    const service = new RealJobSearchService([sourceReturning([tpp])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedTpp).toBe(1);
  });

  it("skips disabled sources", async () => {
    const disabled: JobSource = {
      name: "disabled",
      enabled: false,
      search: async () => [makeVacancy()],
    };
    const service = new RealJobSearchService([disabled], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.fetched).toBe(0);
  });

  it("drops listings that fail schema validation", async () => {
    const malformed = makeVacancy({ id: "" });
    const service = new RealJobSearchService([sourceReturning([malformed])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.fetched).toBe(1);
    expect(result.stats.parsed).toBe(0);
    expect(result.stats.excludedInvalid).toBe(1);
  });

  it("logs the pipeline counters without secrets", async () => {
    const records: Array<{ level: string; message: string; details?: unknown }> = [];
    const capturingLogger: Logger = {
      info: (message, details) => records.push({ level: "info", message, details }),
      warn: (message, details) => records.push({ level: "warn", message, details }),
      error: (message, details) => records.push({ level: "error", message, details }),
    };
    const service = new RealJobSearchService(
      [sourceReturning([makeVacancy({ id: "c1" }), unclearVacancy()])],
      capturingLogger,
    );

    await service.search({ limit: 2 });

    const summary = records.find(record => record.message === "Job search pipeline summary");
    expect(summary).toBeDefined();
    expect(summary?.details).toMatchObject({
      fetched: 2,
      parsed: 2,
      confirmed: 1,
      alternatives: 1,
      returned: 2,
    });
  });

  it("excludes listings whose location appears to exclude the UK", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy({ location: "USA, Canada" })])],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedIneligibleLocation).toBe(1);
    expect(result.stats.alternatives).toBe(0);
  });

  it("excludes stale listings and counts them as closed", async () => {
    const stale = unclearVacancy({ datePosted: "2020-01-01T00:00:00.000Z" });
    const service = new RealJobSearchService([sourceReturning([stale])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedClosed).toBe(1);
  });

  it("does not pad the shortlist with poorly matched roles", async () => {
    const poorFit = unclearVacancy({ title: "Inside Sales Contractor", location: "Worldwide" });
    const service = new RealJobSearchService([sourceReturning([poorFit])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.alternatives).toBe(0);
  });

  it("records an employer-verified alternative without counting it as confirmed", async () => {
    const register: SponsorRegister = {
      name: "stub-register",
      enabled: true,
      isLicensedSponsor: async (employer: string) => ({
        status: "verified",
        evidence: `Employer "${employer}" verified on the register`,
        sourceUrl: "https://gov.example/register.csv",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy()])],
      silentLogger,
      register,
    );

    const result = await service.search();

    expect(result.stats.confirmed).toBe(0);
    expect(result.stats.alternatives).toBe(1);
    expect(result.stats.employerVerifiedAlternatives).toBe(1);
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("unclear");
    expect(result.vacancies[0]?.employerSponsorshipVerified).toBe(true);
    expect(result.vacancies[0]?.fallbackReason).toContain("licensed sponsor");
  });

  it("never verifies the agency itself when the end employer is unknown", async () => {
    const calls: string[] = [];
    const register: SponsorRegister = {
      name: "stub-register",
      enabled: true,
      isLicensedSponsor: async (employer: string) => {
        calls.push(employer);
        return {
          status: "verified",
          evidence: `Employer "${employer}" verified`,
          sourceUrl: "https://gov.example/register.csv",
          checkedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    };
    const recruiter = unclearVacancy({
      employer: "Fruition Group",
      description: "We are recruiting for our client. The role builds React web applications.",
    });
    const service = new RealJobSearchService([sourceReturning([recruiter])], silentLogger, register);

    const result = await service.search();

    expect(calls).toEqual([]);
    expect(result.vacancies[0]?.employerSponsorshipVerified).toBeUndefined();
    expect(result.stats.employerVerifiedAlternatives).toBe(0);
    expect(result.vacancies[0]?.fallbackReason).toContain("no vacancy-specific sponsorship evidence");
  });

  it("verifies the named end employer, not the agency that advertised the role", async () => {
    const calls: string[] = [];
    const register: SponsorRegister = {
      name: "stub-register",
      enabled: true,
      isLicensedSponsor: async (employer: string) => {
        calls.push(employer);
        return {
          status: employer === "Acme Financial Services" ? "verified" : "not_found",
          evidence: `Lookup for ${employer}`,
          sourceUrl: "https://gov.example/register.csv",
          checkedAt: "2026-01-01T00:00:00.000Z",
          registerUpdatedAt: "2026-01-01",
        };
      },
    };
    const recruiter = unclearVacancy({
      employer: "Blue Talent Recruitment",
      description: "Our client Acme Financial Services is hiring a React developer.",
    });
    const service = new RealJobSearchService([sourceReturning([recruiter])], silentLogger, register);

    const result = await service.search();
    const shown = result.vacancies[0];

    expect(calls).toEqual(["Acme Financial Services"]);
    expect(shown?.employerType).toBe("recruiter");
    expect(shown?.endEmployer).toBe("Acme Financial Services");
    expect(shown?.employerSponsorshipVerified).toBe(true);
    expect(shown?.sponsorRegisterUpdatedAt).toBe("2026-01-01");
    expect(shown?.vacancySponsorshipStatus).toBe("unclear");
    expect(result.stats.confirmed).toBe(0);
  });

  it("retains uncertainty when the register has no matching employer", async () => {
    const register: SponsorRegister = {
      name: "stub-register",
      enabled: true,
      isLicensedSponsor: async (employer: string) => ({
        status: "not_found",
        evidence: `Employer "${employer}" was not found`,
        sourceUrl: "https://gov.example/register.csv",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy()])],
      silentLogger,
      register,
    );

    const result = await service.search();

    expect(result.vacancies[0]?.employerSponsorshipVerified).toBeUndefined();
    expect(result.stats.employerVerifiedAlternatives).toBe(0);
  });

  it("retains uncertainty when the register is unavailable", async () => {
    const register: SponsorRegister = {
      name: "stub-register",
      enabled: true,
      isLicensedSponsor: async () => ({
        status: "unavailable",
        evidence: "request timed out",
        sourceUrl: "https://gov.example/register.csv",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy()])],
      silentLogger,
      register,
    );

    const result = await service.search();

    expect(result.vacancies[0]?.employerSponsorshipVerified).toBeUndefined();
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("unclear");
  });

  it("records per-source coverage including failures", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy()], "good"), failingSource("boom", "broken")],
      silentLogger,
    );

    const result = await service.search();

    expect(result.stats.sources).toHaveLength(2);
    expect(result.stats.sources.find(s => s.name === "good")).toMatchObject({
      status: "ok",
      fetched: 1,
      parsed: 1,
    });
    expect(result.stats.sources.find(s => s.name === "broken")).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });

  it("uses a compact default query when no keywords are supplied", async () => {
    const { source, queries } = capturingSource();
    const service = new RealJobSearchService([source], silentLogger);

    await service.search();

    expect(queries).toHaveLength(1);
    expect(queries[0]?.keywords).toEqual(["software developer"]);
    expect(queries[0]?.location).toBeUndefined();
    expect(DEFAULT_KEYWORDS).toEqual(["software developer"]);
  });

  it("passes explicit user keywords and location through unchanged", async () => {
    const { source, queries } = capturingSource();
    const service = new RealJobSearchService([source], silentLogger);

    await service.search({ keywords: ["software", "developer"], location: "leeds" });

    expect(queries[0]?.keywords).toEqual(["software", "developer"]);
    expect(queries[0]?.location).toBe("leeds");
  });

  it("only enables the Adzuna source when credentials are configured", () => {
    const without = createDefaultSources(silentLogger, {}, (async () => {
      throw new Error("not called");
    }) as unknown as typeof fetch);
    expect(without.map(s => s.name)).toContain("remotive");
    expect(without.map(s => s.name)).not.toContain("adzuna");

    const withCreds = createDefaultSources(
      silentLogger,
      { ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "key" },
      (async () => {
        throw new Error("not called");
      }) as unknown as typeof fetch,
    );
    expect(withCreds.map(s => s.name)).toContain("adzuna");
  });

  it("warns but does not enable Adzuna when only one credential is set", async () => {
    const warnings: string[] = [];
    const capturingLogger: Logger = {
      info: () => undefined,
      warn: (message) => warnings.push(String(message)),
      error: () => undefined,
    };
    const sources = createDefaultSources(
      capturingLogger,
      { ADZUNA_APP_ID: "id-only" },
      (async () => {
        throw new Error("not called");
      }) as unknown as typeof fetch,
    );

    expect(sources.map(s => s.name)).not.toContain("adzuna");
    expect(warnings.some(w => w.includes("ADZUNA_APP_ID") && w.includes("ADZUNA_APP_KEY"))).toBe(
      true,
    );
  });
});

describe("expanded alternative cap", () => {
  it("caps unconfirmed alternatives at five", async () => {
    expect(MAX_ALTERNATIVES).toBe(5);
    const service = new RealJobSearchService(
      [
        sourceReturning([
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
        ]),
      ],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toHaveLength(5);
    expect(result.stats.alternatives).toBe(5);
    expect(result.stats.excludedUnclear).toBe(2);
    expect(result.stats.returned).toBe(5);
  });

  it("shows fewer than five alternatives when fewer are eligible", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy(), unclearVacancy()])],
      silentLogger,
    );

    const result = await service.search();

    expect(result.stats.alternatives).toBe(2);
    expect(result.stats.excludedUnclear).toBe(0);
  });

  it("keeps alternatives sorted by relevance score, highest first", async () => {
    const service = new RealJobSearchService(
      [
        sourceReturning([
          unclearVacancy({ id: "mid", title: "React Developer" }),
          unclearVacancy({ id: "low", title: "Software Developer" }),
          unclearVacancy({ id: "high", title: "Junior React Developer" }),
        ]),
      ],
      silentLogger,
    );

    const result = await service.search();
    const scores = result.vacancies.map(v => v.matchScore ?? 0);

    expect(result.vacancies.map(v => v.id)).toEqual(["high", "mid", "low"]);
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? 0);
  });

  it("lets confirmed vacancies consume result slots before alternatives", async () => {
    const service = new RealJobSearchService(
      [
        sourceReturning([
          makeVacancy({ id: "c1" }),
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
        ]),
      ],
      silentLogger,
    );

    const result = await service.search({ limit: 3 });

    // 1 confirmed + only 2 remaining slots, even though 3 alternatives qualify.
    expect(result.vacancies).toHaveLength(3);
    expect(result.stats.confirmed).toBe(1);
    expect(result.stats.alternatives).toBe(2);
    expect(result.stats.excludedUnclear).toBe(1);
  });

  it("shows no alternatives when confirmed vacancies use every slot", async () => {
    const service = new RealJobSearchService(
      [
        sourceReturning([
          makeVacancy({ id: "c1" }),
          unclearVacancy(),
          unclearVacancy(),
        ]),
      ],
      silentLogger,
    );

    const result = await service.search({ limit: 1 });

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(result.stats.alternatives).toBe(0);
    expect(result.stats.excludedUnclear).toBe(2);
  });
});

describe("register diagnostics", () => {
  interface Recorded {
    readonly message: string;
    readonly details?: unknown;
  }

  function capture(): { logger: Logger; records: Recorded[] } {
    const records: Recorded[] = [];
    return {
      logger: {
        info: (message, details) => records.push({ message: String(message), details }),
        warn: () => undefined,
        error: () => undefined,
      },
      records,
    };
  }

  it("logs the register status and each lookup outcome", async () => {
    const { logger, records } = capture();
    const register: SponsorRegister = {
      name: "stub-register",
      enabled: true,
      isLicensedSponsor: async (employer: string) =>
        employer === "Acme Ltd"
          ? {
              status: "verified",
              evidence: "match",
              sourceUrl: "https://gov.example/register.csv",
              checkedAt: "2026-01-01T00:00:00.000Z",
              matchedEntry: "Acme Ltd",
            }
          : {
              status: "not_found",
              evidence: "no match",
              sourceUrl: "https://gov.example/register.csv",
              checkedAt: "2026-01-01T00:00:00.000Z",
            },
    };
    const service = new RealJobSearchService(
      [
        sourceReturning([
          unclearVacancy({ employer: "Acme Ltd" }),
          unclearVacancy({ employer: "Unknown Startup" }),
        ]),
      ],
      logger,
      register,
    );

    await service.search();

    expect(records.some(r => r.message.includes("verification enabled"))).toBe(true);
    const outcomes = records.filter(r => r.message.includes("lookup outcome"));
    expect(outcomes).toHaveLength(2);
    const details = JSON.stringify(outcomes.map(o => o.details));
    expect(details).toContain("verified");
    expect(details).toContain("not_found");
  });

  it("logs when register verification is disabled", async () => {
    const { logger, records } = capture();
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy()])],
      logger,
      new NullSponsorRegister(),
    );

    await service.search();

    expect(records.some(r => r.message.includes("disabled"))).toBe(true);
  });
});

describe("employer register outcome storage", () => {
  function registerReturning(
    status: "verified" | "not_found" | "unavailable",
  ): SponsorRegister {
    return {
      name: "stub-register",
      enabled: true,
      isLicensedSponsor: async (employer: string) => ({
        status,
        evidence: `Lookup for ${employer}: ${status}`,
        sourceUrl: "https://gov.example/register.csv",
        checkedAt: "2026-01-01T00:00:00.000Z",
        registerUpdatedAt: "2026-01-01",
        ...(status === "verified" ? { matchedEntry: "Acme Ltd" } : {}),
      }),
    };
  }

  it("stores a verified outcome separately and never confirms the vacancy", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy({ employer: "Acme Ltd" })])],
      silentLogger,
      registerReturning("verified"),
    );

    const v = (await service.search()).vacancies[0]!;

    expect(v.employerRegisterStatus).toBe("verified");
    expect(v.sponsorRegisterStatus).toBe("verified");
    expect(v.employerSponsorshipVerified).toBe(true);
    expect(v.sponsorRegisterUpdatedAt).toBe("2026-01-01");
    expect(v.vacancySponsorshipStatus).toBe("unclear");
  });

  it("stores a not_found outcome without confirming the vacancy or denying a licence", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy({ employer: "Acme Ltd" })])],
      silentLogger,
      registerReturning("not_found"),
    );

    const v = (await service.search()).vacancies[0]!;

    expect(v.employerRegisterStatus).toBe("not_found");
    expect(v.sponsorRegisterStatus).toBe("not_found");
    expect(v.employerSponsorshipVerified).toBeUndefined();
    expect(v.vacancySponsorshipStatus).toBe("unclear");
  });

  it("stores an unavailable outcome without implying a negative result", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy({ employer: "Acme Ltd" })])],
      silentLogger,
      registerReturning("unavailable"),
    );

    const v = (await service.search()).vacancies[0]!;

    expect(v.employerRegisterStatus).toBe("unavailable");
    expect(v.employerSponsorshipVerified).toBeUndefined();
  });

  it("records a recruiter vacancy with an unknown client as not_checked", async () => {
    const calls: string[] = [];
    const base = registerReturning("verified");
    const register: SponsorRegister = {
      ...base,
      isLicensedSponsor: async (employer: string) => {
        calls.push(employer);
        return base.isLicensedSponsor(employer);
      },
    };
    const recruiter = unclearVacancy({
      employer: "Fruition Group",
      description: "We are recruiting for our client. The role builds React web applications.",
    });
    const service = new RealJobSearchService(
      [sourceReturning([recruiter])],
      silentLogger,
      register,
    );

    const v = (await service.search()).vacancies[0]!;

    expect(calls).toEqual([]);
    expect(v.employerRegisterStatus).toBe("not_checked");
    expect(v.employerSponsorshipVerified).toBeUndefined();
  });

  it("records an outcome for confirmed vacancies too, without downgrading them", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([makeVacancy({ employer: "Acme Ltd" })])],
      silentLogger,
      registerReturning("not_found"),
    );

    const v = (await service.search()).vacancies[0]!;

    expect(v.vacancySponsorshipStatus).toBe("confirmed");
    expect(v.employerRegisterStatus).toBe("not_found");
  });
});

describe("alternative accounting", () => {
  it("counts unclear listings below the relevance threshold separately from the cap", async () => {
    const service = new RealJobSearchService(
      [
        sourceReturning([
          unclearVacancy({ title: "Support Advisor", location: "Worldwide" }),
          unclearVacancy(),
        ]),
      ],
      silentLogger,
    );

    const result = await service.search();

    // The low-relevance listing is dropped by the score floor, not the cap.
    expect(result.stats.excludedLowRelevance).toBe(1);
    expect(result.stats.excludedUnclear).toBe(0);
    expect(result.stats.alternatives).toBe(1);
  });

  it("accounts for every unclear candidate after dedup", async () => {
    const service = new RealJobSearchService(
      [
        sourceReturning([
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy(),
          unclearVacancy({ title: "Support Advisor", location: "Worldwide" }),
        ]),
      ],
      silentLogger,
    );

    const result = await service.search();
    const { alternatives, excludedUnclear, excludedLowRelevance } = result.stats;

    // shown + over-cap + below-threshold must equal the unclear candidates.
    expect(alternatives + excludedUnclear + excludedLowRelevance).toBe(4);
  });

  it("does not shortlist an unclear role whose text shows no profile skill match", async () => {
    const generic = unclearVacancy({
      id: "veeqo-1",
      title: "Software Development Engineer",
      employer: "Veeqo",
      location: "Exeter, Devon",
      description:
        "Work on our logistics platform used by thousands of retailers. You will build features, fix defects and collaborate across the team.",
    });
    const service = new RealJobSearchService([sourceReturning([generic])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.alternatives).toBe(0);
    expect(result.stats.excludedLowRelevance).toBe(1);
  });

  it("still shortlists a described graduate role with no exact skill match", async () => {
    const graduate = unclearVacancy({
      id: "grad-1",
      title: "Graduate Software Developer",
      description:
        "Full training provided and no experience necessary. We invest in your development throughout the programme.",
    });
    const service = new RealJobSearchService([sourceReturning([graduate])], silentLogger);

    const result = await service.search();

    expect(result.stats.alternatives).toBe(1);
    expect(result.stats.excludedLowRelevance).toBe(0);
  });
});

describe("coverage accounting", () => {
  it("counts confirmed vacancies dropped by the result limit as excluded, not lost", async () => {
    const confirmedRoles = Array.from(
      { length: 7 },
      (_, i) =>
        makeVacancy({
          id: `c${i + 1}`,
          location: `Sheffield ${i + 1}`,
          applicationUrl: `https://example.com/apply/c${i + 1}`,
          sourceUrl: `https://example.com/jobs/c${i + 1}`,
        }),
    );
    const service = new RealJobSearchService([sourceReturning(confirmedRoles)], silentLogger);

    const result = await service.search({ limit: 5 });

    expect(result.vacancies).toHaveLength(5);
    expect(result.stats.confirmed).toBe(5);
    expect(result.stats.excludedConfirmedOverLimit).toBe(2);
    expect(result.stats.confirmed + result.stats.excludedConfirmedOverLimit).toBe(
      result.stats.parsed,
    );
  });

  it("reconciles every parsed listing exactly once across all counters", async () => {
    const invalid = { ...unclearVacancy({ id: "invalid-1" }), id: "" } as Vacancy;
    const stale = unclearVacancy({ id: "stale-1", datePosted: "2020-01-01T00:00:00.000Z" });
    const paidTraining = unclearVacancy({
      id: "pt-1",
      title: "Software Developer Placement Programme",
      description:
        "A self-funded training programme. Course fees apply and a deposit is required.",
      location: "Leeds",
    });
    const seniorRoles = [
      unclearVacancy({ id: "s-1", title: "Senior Software Developer" }),
      unclearVacancy({ id: "s-2", title: "Lead Full Stack Software Developer" }),
    ];
    const notOffered = makeVacancy({
      id: "no-1",
      vacancySponsorshipStatus: "not_offered",
      title: "Software Developer",
    });
    const tpp = unclearVacancy({
      id: "tpp-1",
      employer: "TPP",
      title: "Graduate Software Developer",
      location: "Leeds, Yorkshire",
    });
    const foreign = unclearVacancy({ id: "f-1", location: "USA, Canada" });
    const dupPair1 = [
      unclearVacancy({
        id: "d1a",
        title: "Web Developer",
        employer: "Acme Ltd",
        location: "Leeds",
        applicationUrl: "https://example.com/jobs/a/1",
        sourceUrl: "https://example.com/jobs/a/1",
      }),
      unclearVacancy({
        id: "d1b",
        title: "Web Developer",
        employer: "Acme Ltd",
        location: "Leeds",
        applicationUrl: "https://example.com/jobs/a/1",
        sourceUrl: "https://example.com/jobs/a/1",
      }),
    ];
    const dupPair2 = [
      unclearVacancy({
        id: "d2a",
        title: "React Developer",
        employer: "Beta Ltd",
        location: "Leeds",
        applicationUrl: "https://example.com/jobs/b/1",
        sourceUrl: "https://example.com/jobs/b/1",
      }),
      unclearVacancy({
        id: "d2b",
        title: "React Developer",
        employer: "Beta Ltd",
        location: "Leeds",
        applicationUrl: "https://example.com/jobs/b/1",
        sourceUrl: "https://example.com/jobs/b/1",
      }),
    ];
    const lowRelevance = unclearVacancy({
      id: "low-1",
      title: "Support Advisor",
      location: "Worldwide",
    });
    const alternatives = Array.from(
      { length: 6 },
      (_, i) => unclearVacancy({ id: `alt-${i + 1}` }),
    );

    const service = new RealJobSearchService(
      [
        sourceReturning([
          invalid,
          stale,
          paidTraining,
          ...seniorRoles,
          notOffered,
          tpp,
          foreign,
          ...dupPair1,
          ...dupPair2,
          lowRelevance,
          ...alternatives,
        ]),
      ],
      silentLogger,
    );

    const result = await service.search({ limit: 5 });
    const s = result.stats;

    expect(s.fetched).toBe(19);
    expect(s.excludedInvalid).toBe(1);
    expect(s.excludedClosed).toBe(1);
    expect(s.excludedPaidTraining).toBe(1);
    expect(s.excludedSenior).toBe(2);
    expect(s.excludedNotOffered).toBe(1);
    expect(s.excludedTpp).toBe(1);
    expect(s.excludedIneligibleLocation).toBe(1);
    expect(s.excludedDuplicates).toBe(2);
    expect(s.confirmed).toBe(0);
    expect(s.excludedConfirmedOverLimit).toBe(0);
    expect(s.alternatives).toBe(5);
    expect(s.excludedUnclear).toBe(3);
    expect(s.excludedLowRelevance).toBe(1);

    // Every listing that passed schema validation is accounted for exactly
    // once across the early filters, dedup and the result/ranking counters.
    const accounted =
      s.excludedClosed +
      s.excludedPaidTraining +
      s.excludedSenior +
      s.excludedNotOffered +
      s.excludedTpp +
      s.excludedIneligibleLocation +
      s.excludedDuplicates +
      s.confirmed +
      s.excludedConfirmedOverLimit +
      s.alternatives +
      s.excludedUnclear +
      s.excludedLowRelevance;

    expect(accounted).toBe(s.parsed);
  });
});

describe("decision audit logging", () => {
  interface Recorded {
    readonly message: string;
    readonly details?: unknown;
  }

  function capture(): { logger: Logger; records: Recorded[] } {
    const records: Recorded[] = [];
    return {
      logger: {
        info: (message, details) => records.push({ message: String(message), details }),
        warn: () => undefined,
        error: () => undefined,
      },
      records,
    };
  }

  it("does not log per-listing decisions unless enabled", async () => {
    const { logger, records } = capture();
    const service = new RealJobSearchService([sourceReturning([unclearVacancy()])], logger);

    await service.search();

    expect(records.some(r => r.message.includes("Job search decision"))).toBe(false);
  });

  it("logs each listing decision with identity and stage but no description", async () => {
    const { logger, records } = capture();
    const first = unclearVacancy({
      id: "dup-a",
      employer: "Acme Ltd",
      title: "Web Developer",
      applicationUrl: "https://a.example/1",
      sourceUrl: "https://a.example/1",
    });
    const second = unclearVacancy({
      id: "dup-b",
      employer: "Acme Ltd",
      title: "Web Developer",
      applicationUrl: "https://b.example/2",
      sourceUrl: "https://b.example/2",
    });
    const low = unclearVacancy({ id: "low", title: "Support Advisor", location: "Worldwide" });
    const service = new RealJobSearchService(
      [sourceReturning([first, second, low])],
      logger,
      new NullSponsorRegister(),
      { debugDecisions: true },
    );

    await service.search();

    const decisions = records.filter(r => r.message.includes("Job search decision"));
    const stages = decisions.map(r => (r.details as { stage?: string }).stage);
    expect(stages).toContain("candidate_unclear");
    expect(stages).toContain("duplicate");
    expect(stages).toContain("excluded_below_threshold");

    const dup = decisions.find(r => (r.details as { stage?: string }).stage === "duplicate");
    const dupDetails = JSON.stringify(dup?.details);
    expect(dupDetails).toContain("https://a.example/1");
    expect(dupDetails).toContain("https://b.example/2");

    // Free-text fields must never be logged by decision traces.
    expect(JSON.stringify(records)).not.toContain("No explicit sponsorship support found");
  });
});

describe("paid training adverts", () => {
  it("excludes a self-funded placement programme that charges fees", async () => {
    const advert = unclearVacancy({
      id: "paid-training-1",
      title: "Software Developer Placement Programme - No experience needed",
      employer: "IT Online Learning",
      description:
        "A self-funded training programme. Course fees apply and you will be required to pay a deposit.",
      location: "Leeds",
    });
    const service = new RealJobSearchService([sourceReturning([advert])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedPaidTraining).toBe(1);
    expect(result.stats.alternatives).toBe(0);
    expect(result.stats.returned).toBe(0);
  });

  it("excludes a paid bootcamp that charges applicant fees", async () => {
    const advert = unclearVacancy({
      id: "paid-training-2",
      title: "Full Stack Bootcamp",
      description: "A 12-week bootcamp. Programme fees are payable upfront.",
    });
    const service = new RealJobSearchService([sourceReturning([advert])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedPaidTraining).toBe(1);
  });

  it("keeps a legitimate job that offers training", async () => {
    const job = unclearVacancy({
      id: "training-job-1",
      title: "Graduate Software Developer",
      description:
        "Full training provided and no experience necessary. We invest in your development throughout the programme.",
    });
    const service = new RealJobSearchService([sourceReturning([job])], silentLogger);

    const result = await service.search();

    expect(result.stats.excludedPaidTraining).toBe(0);
    expect(result.vacancies).toHaveLength(1);
  });

  it("keeps a confirmed sponsorship job even when it mentions training", async () => {
    const job = makeVacancy({
      id: "training-job-2",
      title: "Software Developer",
      description:
        "We provide a structured training programme and will sponsor a Skilled Worker visa. All course fees are covered by us.",
    });
    const service = new RealJobSearchService([sourceReturning([job])], silentLogger);

    const result = await service.search();

    expect(result.stats.excludedPaidTraining).toBe(0);
    expect(result.stats.confirmed).toBe(1);
    expect(result.vacancies[0]?.id).toBe("training-job-2");
  });

  it("does not exclude a paid industrial placement that charges no fees", async () => {
    const placement = unclearVacancy({
      id: "placement-1",
      title: "Industrial Placement Software Engineer",
      description: "A paid 12-month placement programme. No fees apply to applicants.",
    });
    const service = new RealJobSearchService([sourceReturning([placement])], silentLogger);

    const result = await service.search();

    expect(result.stats.excludedPaidTraining).toBe(0);
    expect(result.vacancies).toHaveLength(1);
  });
});

describe("seniority eligibility", () => {
  it("excludes clearly senior roles from the default junior shortlist", async () => {
    const senior = unclearVacancy({ id: "senior-1", title: "Lead Full Stack Software Developer" });
    const junior = unclearVacancy({ id: "junior-1" });
    const service = new RealJobSearchService([sourceReturning([senior, junior])], silentLogger);

    const result = await service.search();

    expect(result.stats.excludedSenior).toBe(1);
    expect(result.stats.alternatives).toBe(1);
    expect(result.vacancies.map(v => v.id)).toEqual(["junior-1"]);
  });

  it("excludes confirmed senior roles from the junior shortlist as well", async () => {
    const senior = makeVacancy({ id: "senior-c", title: "Senior Software Developer" });
    const service = new RealJobSearchService([sourceReturning([senior])], silentLogger);

    const result = await service.search();

    expect(result.stats.excludedSenior).toBe(1);
    expect(result.stats.confirmed).toBe(0);
    expect(result.vacancies).toEqual([]);
  });

  it("keeps senior roles when the user explicitly requests them", async () => {
    const senior = makeVacancy({ id: "senior-c", title: "Senior Software Developer" });
    const service = new RealJobSearchService([sourceReturning([senior])], silentLogger);

    const result = await service.search({ keywords: ["senior", "software", "developer"] });

    expect(result.stats.excludedSenior).toBe(0);
    expect(result.stats.confirmed).toBe(1);
    expect(result.vacancies[0]?.id).toBe("senior-c");
  });

  it("never excludes legitimate junior, graduate or QA roles", async () => {
    const roles = [
      unclearVacancy({ id: "g1", title: "Graduate Software Developer" }),
      unclearVacancy({ id: "j1", title: "Junior React Developer" }),
      unclearVacancy({ id: "q1", title: "QA Tester" }),
      unclearVacancy({ id: "t1", title: "Industrial Placement Software Engineer" }),
    ];
    const service = new RealJobSearchService([sourceReturning(roles)], silentLogger);

    const result = await service.search();

    expect(result.stats.excludedSenior).toBe(0);
    expect(result.vacancies.map(v => v.id).sort()).toEqual(["g1", "j1", "q1", "t1"]);
    expect(result.stats.alternatives).toBe(4);
  });

  it("does not treat false-positive seniority terms as senior roles", async () => {
    const listing = unclearVacancy({ id: "leadgen-1", title: "Lead Generation Specialist" });
    const service = new RealJobSearchService([sourceReturning([listing])], silentLogger);

    const result = await service.search();

    // Not a senior role: it falls through to the relevance floor instead.
    expect(result.stats.excludedSenior).toBe(0);
    expect(result.stats.excludedLowRelevance).toBe(1);
    expect(result.vacancies).toEqual([]);
  });
});
