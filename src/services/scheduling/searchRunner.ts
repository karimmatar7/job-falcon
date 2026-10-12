import type { JobSearchQuery, JobSearchResult } from "../jobSearch.js";
import { RealJobSearchService } from "../jobSearch.js";
import type { SponsorRegister } from "../sponsorRegister.js";
import { createDefaultSponsorRegister } from "../sponsorRegister.js";
import type { Logger } from "../../utils/logger.js";

/** The search boundary the scheduler depends on (easy to fake in tests). */
export type JobSearchFn = (query: JobSearchQuery) => Promise<JobSearchResult>;

/**
 * Short-lived result cache. Scheduled runs are a day apart, so this exists for
 * a narrower purpose: if a run is retried (for example after a restart) within
 * the TTL, the identical query is served from memory and no new Adzuna/Remotive
 * request is made. The underlying pipeline keeps its own per-source rate
 * limits; the scheduler adds no extra requests of its own.
 */
export const DEFAULT_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

export interface ScheduledSearchOptions {
  readonly logger: Logger;
  /** Inject a ready-made pipeline (tests); otherwise a real one is built. */
  readonly service?: { search(query: JobSearchQuery): Promise<JobSearchResult> };
  readonly sponsorRegister?: SponsorRegister;
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
}

function cacheKey(query: JobSearchQuery): string {
  return JSON.stringify({
    keywords: query.keywords ?? null,
    location: query.location ?? null,
    limit: query.limit ?? null,
  });
}

export function createScheduledSearch(options: ScheduledSearchOptions): JobSearchFn {
  const service =
    options.service ??
    new RealJobSearchService(
      undefined,
      options.logger,
      options.sponsorRegister ??
        createDefaultSponsorRegister(process.env, fetch, options.logger),
    );
  const ttl = options.cacheTtlMs ?? DEFAULT_SEARCH_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());

  let cachedKey: string | undefined;
  let cachedResult: JobSearchResult | undefined;
  let cachedAt = 0;

  return async (query) => {
    const key = cacheKey(query);
    if (
      cachedResult !== undefined &&
      cachedKey === key &&
      now().getTime() - cachedAt < ttl
    ) {
      options.logger.info("Scheduled search served from cache", { ageMs: now().getTime() - cachedAt });
      return cachedResult;
    }

    const result = await service.search(query);
    cachedKey = key;
    cachedResult = result;
    cachedAt = now().getTime();
    return result;
  };
}
