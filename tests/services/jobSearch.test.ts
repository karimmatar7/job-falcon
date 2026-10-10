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

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("RealJobSearchService", () => {
  it("returns confirmed vacancies first, then up to two relevant alternatives", async () => {
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

    expect(result.vacancies).toHaveLength(3);
    expect(result.vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(result.vacancies.slice(1).every(v => v.vacancySponsorshipStatus === "unclear")).toBe(
      true,
    );
    expect(result.stats.fetched).toBe(4);
    expect(result.stats.parsed).toBe(4);
    expect(result.stats.confirmed).toBe(1);
    expect(result.stats.alternatives).toBe(2);
    expect(result.stats.excludedUnclear).toBe(1);
    expect(result.stats.returned).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("returns relevant alternatives when there are zero confirmed results", async () => {
    const service = new RealJobSearchService(
      [sourceReturning([unclearVacancy(), unclearVacancy(), unclearVacancy()])],
      silentLogger,
    );

    const result = await service.search();

    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies.every(v => v.vacancySponsorshipStatus === "unclear")).toBe(true);
    expect(result.stats.confirmed).toBe(0);
    expect(result.stats.alternatives).toBe(2);
    expect(result.stats.excludedUnclear).toBe(1);
    expect(result.stats.returned).toBe(2);
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
});
