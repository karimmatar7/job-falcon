import type { JobSearchResult, JobSearchStats } from "../src/services/jobSearch.js";
import type { Vacancy } from "../src/models/vacancy.js";
import type { SchedulerTimers } from "../src/services/scheduling/scheduler.js";
import type { Logger } from "../src/utils/logger.js";

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function makeStats(overrides: Partial<JobSearchStats> = {}): JobSearchStats {
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

export function makeVacancy(overrides: Partial<Vacancy> = {}): Vacancy {
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

export function makeJobSearchResult(
  vacancies: readonly Vacancy[],
  overrides: Partial<JobSearchResult> = {},
): JobSearchResult {
  return {
    vacancies: [...vacancies],
    stats: makeStats({ fetched: vacancies.length, parsed: vacancies.length }),
    errors: [],
    ...overrides,
  };
}

/** Deterministic timer seam so scheduler tests never touch the real clock. */
export class FakeTimers implements SchedulerTimers {
  private readonly handlers = new Map<unknown, () => void>();
  private nextId = 0;

  setTimeout(handler: () => void): unknown {
    const id = this.nextId++;
    this.handlers.set(id, handler);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.handlers.delete(handle);
  }

  get pendingCount(): number {
    return this.handlers.size;
  }

  fireAll(): void {
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    for (const handler of handlers) handler();
  }
}