import { describe, expect, it } from "vitest";
import type { Vacancy } from "../../src/models/vacancy.js";
import { findDuplicates } from "../../src/services/deduplication.js";

function makeVacancy(overrides: Partial<Vacancy> = {}): Vacancy {
  return {
    id: "job-1",
    title: "Software Developer",
    employer: "Acme Ltd",
    location: "Sheffield",
    source: "test-source",
    sourceUrl: "https://example.com/jobs/1",
    applicationUrl: "https://example.com/apply/1",
    vacancySponsorshipStatus: "unclear",
    sponsorshipEvidence: "No explicit sponsorship support found.",
    employerSponsorLicence: "unknown",
    employerLicenceEvidence: "No licence mentioned.",
    lastVerifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("findDuplicates", () => {
  it("keeps the same employer+title advertised in different locations", () => {
    // Regression: the IT Online Learning placement programme is advertised in
    // nine UK cities. These are distinct adverts, not one repeat.
    const cities = [
      "Leeds, West Yorkshire",
      "Glasgow, Scotland",
      "Manchester, Greater Manchester",
      "Sheffield, South Yorkshire",
      "Birmingham, West Midlands",
      "Edinburgh, Scotland",
      "Bristol, South West England",
      "North West London, London",
      "Cardiff County, Wales",
    ];
    const adverts = cities.map((location, index) =>
      makeVacancy({
        id: `itol-${index}`,
        employer: "IT Online Learning",
        title: "Software Developer Placement Programme",
        location,
        sourceUrl: `https://www.adzuna.co.uk/jobs/land/ad/${index}`,
        applicationUrl: `https://www.adzuna.co.uk/jobs/land/ad/${index}`,
      }),
    );

    const result = findDuplicates(adverts);

    expect(result.kept).toHaveLength(cities.length);
    expect(result.duplicates).toHaveLength(0);
  });

  it("deduplicates the same employer+title+location from different sources", () => {
    const remotive = makeVacancy({
      id: "remotive-1",
      source: "remotive",
      sourceUrl: "https://remotive.com/remote-jobs/1",
      applicationUrl: "https://remotive.com/remote-jobs/1",
    });
    const adzuna = makeVacancy({
      id: "adzuna-1",
      source: "adzuna",
      sourceUrl: "https://www.adzuna.co.uk/jobs/details/1",
      applicationUrl: "https://www.adzuna.co.uk/jobs/details/1",
    });

    const result = findDuplicates([remotive, adzuna]);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.source).toBe("remotive");
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.duplicate.source).toBe("adzuna");
  });

  it("deduplicates a true repeat sharing the exact application URL", () => {
    const first = makeVacancy({ id: "job-a" });
    const repeat = makeVacancy({
      id: "job-b",
      title: "Different Title",
      location: "Different Place",
    });

    const result = findDuplicates([first, repeat]);

    expect(result.kept).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
  });

  it("deduplicates a repeat sharing an id", () => {
    const first = makeVacancy({ id: "shared-id" });
    const repeat = makeVacancy({
      id: "shared-id",
      title: "Another Title",
      location: "Another Place",
      sourceUrl: "https://example.com/jobs/2",
      applicationUrl: "https://example.com/apply/2",
    });

    const result = findDuplicates([first, repeat]);

    expect(result.kept).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
  });

  it("keeps the same employer with different titles", () => {
    const developer = makeVacancy({
      id: "dev",
      title: "Software Developer",
      sourceUrl: "https://example.com/jobs/dev",
      applicationUrl: "https://example.com/apply/dev",
    });
    const manager = makeVacancy({
      id: "mgr",
      title: "Engineering Manager",
      sourceUrl: "https://example.com/jobs/mgr",
      applicationUrl: "https://example.com/apply/mgr",
    });

    const result = findDuplicates([developer, manager]);

    expect(result.kept).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });
});
