import { describe, expect, it } from "vitest";
import type { Vacancy } from "../../src/models/vacancy.js";
import { RealJobSearchService } from "../../src/services/jobSearch.js";
import type { JobSource } from "../../src/services/sources/base.js";
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

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("RealJobSearchService", () => {
  it("returns confirmed sponsorship vacancies only", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([makeVacancy()])],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(result.stats.fetched).toBe(1);
    expect(result.stats.parsed).toBe(1);
    expect(result.stats.returned).toBe(1);
    expect(result.errors).toEqual([]);
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

  it("excludes unclear sponsorship by default", async () => {
    const unclear = makeVacancy({
      id: "job-unclear",
      vacancySponsorshipStatus: "unclear",
      sponsorshipEvidence: "No explicit sponsorship support found.",
    });
    const service = new RealJobSearchService([sourceReturning([unclear])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedUnclear).toBe(1);
  });

  it("includes unclear sponsorship when explicitly requested", async () => {
    const unclear = makeVacancy({
      id: "job-unclear",
      vacancySponsorshipStatus: "unclear",
      sponsorshipEvidence: "No explicit sponsorship support found.",
    });
    const service = new RealJobSearchService([sourceReturning([unclear])], silentLogger);

    const result = await service.search({ includeUnclear: true });

    expect(result.vacancies).toHaveLength(1);
    expect(result.stats.excludedUnclear).toBe(1);
    expect(result.stats.returned).toBe(1);
  });

  it("excludes listings that explicitly do not offer sponsorship", async () => {
    const notOffered = makeVacancy({
      id: "job-no",
      vacancySponsorshipStatus: "not_offered",
      sponsorshipEvidence: "We are unable to sponsor.",
    });
    const service = new RealJobSearchService([sourceReturning([notOffered])], silentLogger);

    const result = await service.search({ includeUnclear: true });

    expect(result.vacancies).toEqual([]);
    expect(result.stats.excludedNotOffered).toBe(1);
  });

  it("deduplicates listings sharing an application URL", async () => {
    const first = makeVacancy({ id: "job-a" });
    const second = makeVacancy({ id: "job-b", title: "Software Developer" });
    const service = new RealJobSearchService([sourceReturning([first, second])], silentLogger);

    const result = await service.search();

    expect(result.vacancies).toHaveLength(1);
    expect(result.stats.excludedDuplicates).toBe(1);
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
    const service = new RealJobSearchService([sourceReturning([makeVacancy()])], capturingLogger);

    await service.search();

    const summary = records.find(record => record.message === "Job search pipeline summary");
    expect(summary).toBeDefined();
    expect(summary?.details).toMatchObject({
      fetched: 1,
      parsed: 1,
      rejectedSponsorship: 0,
      rejectedDuplicates: 0,
      returned: 1,
    });
  });
});
