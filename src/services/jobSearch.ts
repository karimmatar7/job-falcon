import { vacancySchema } from '../models/vacancy.js';
import type { Vacancy } from '../models/vacancy.js';
import { computeMatchScore, explainMatch } from './relevanceScoring.js';
import type { Profile } from './relevanceScoring.js';
import { findDuplicates, isTppExcluded } from './deduplication.js';
import { DummySource } from './sources/dummy.js';
import { RemotiveSource } from './sources/remotive.js';
import type { JobSource } from './sources/base.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

export interface JobSearchQuery {
  readonly keywords?: string[];
  readonly location?: string;
  readonly limit?: number;
  readonly includeUnclear?: boolean;
}

export interface JobSearchStats {
  fetched: number;
  parsed: number;
  excludedInvalid: number;
  excludedClosed: number;
  excludedUnclear: number;
  excludedNotOffered: number;
  excludedDuplicates: number;
  excludedTpp: number;
  returned: number;
}

export interface JobSearchResult {
  readonly vacancies: Vacancy[];
  readonly stats: JobSearchStats;
  readonly errors: string[];
}

const DEFAULT_KEYWORDS = [
  'javascript',
  'typescript',
  'react',
  'web developer',
  'software developer',
  'frontend',
  'full stack',
];

const PROFILE: Profile = {
  skills: ['javascript', 'typescript', 'react', 'web development', 'sql', 'drupal', 'testing', 'supabase', 'figma', 'adobe', 'arduino', 'raspberry', 'ai tools'],
  locations: ['barnsley', 'sheffield', 'leeds', 'manchester', 'yorkshire'],
};

export class RealJobSearchService {
  private readonly sources: readonly JobSource[];
  private readonly logger: Logger;

  constructor(sources?: readonly JobSource[], logger: Logger = createLogger()) {
    this.logger = logger;
    this.sources = sources ?? [new RemotiveSource(logger), new DummySource()];
  }

  async search(query: JobSearchQuery = {}): Promise<JobSearchResult> {
    const keywords = query.keywords && query.keywords.length > 0 ? query.keywords : DEFAULT_KEYWORDS;
    const limit = Math.min(query.limit ?? 5, 20);
    const includeUnclear = query.includeUnclear ?? false;

    const fetched: Vacancy[] = [];
    const parsed: Vacancy[] = [];
    const errors: string[] = [];
    let sourcesAttempted = 0;
    let sourcesFailed = 0;
    let excludedInvalid = 0;

    for (const source of this.sources) {
      if (!source.enabled) {
        this.logger.info('Job source disabled; skipping', { source: source.name });
        continue;
      }

      sourcesAttempted++;
      try {
        const results = await source.search({
          keywords,
          limit,
          ...(query.location === undefined ? {} : { location: query.location }),
        });
        fetched.push(...results);

        let valid = 0;
        for (const candidate of results) {
          const validation = vacancySchema.safeParse(candidate);
          if (validation.success) {
            parsed.push(validation.data);
            valid++;
          } else {
            excludedInvalid++;
          }
        }

        this.logger.info('Job source fetched listings', {
          source: source.name,
          fetched: results.length,
          parsed: valid,
        });
      } catch (e) {
        sourcesFailed++;
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${source.name}: ${msg}`);
        this.logger.warn('Job source failed', { source: source.name, message: msg });
      }
    }

    const stats: JobSearchStats = {
      fetched: fetched.length,
      parsed: parsed.length,
      excludedInvalid,
      excludedClosed: 0,
      excludedUnclear: 0,
      excludedNotOffered: 0,
      excludedDuplicates: 0,
      excludedTpp: 0,
      returned: 0,
    };

    let filtered = parsed.filter(v => {
      if (v.vacancySponsorshipStatus === 'confirmed') return true;
      if (v.vacancySponsorshipStatus === 'unclear') {
        stats.excludedUnclear++;
        return includeUnclear;
      }
      if (v.vacancySponsorshipStatus === 'not_offered') {
        stats.excludedNotOffered++;
        return false;
      }
      stats.excludedUnclear++;
      return includeUnclear;
    });

    filtered = filtered.filter(v => {
      if (isTppExcluded(v)) {
        stats.excludedTpp++;
        return false;
      }
      return true;
    });

    const dupResult = findDuplicates(filtered);
    stats.excludedDuplicates = dupResult.duplicates.length;
    filtered = dupResult.kept;

    const scored = filtered
      .map(v => {
        const score = computeMatchScore(v, PROFILE);
        return {
          ...v,
          matchScore: score,
          matchExplanation: explainMatch(v, score, PROFILE),
        };
      })
      .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

    const vacancies = scored.slice(0, limit);
    stats.returned = vacancies.length;

    this.logger.info('Job search pipeline summary', {
      sourcesAttempted,
      sourcesFailed,
      fetched: stats.fetched,
      parsed: stats.parsed,
      excludedInvalid: stats.excludedInvalid,
      rejectedClosed: stats.excludedClosed,
      rejectedDuplicates: stats.excludedDuplicates,
      rejectedSponsorship: stats.excludedUnclear + stats.excludedNotOffered,
      excludedUnclear: stats.excludedUnclear,
      excludedNotOffered: stats.excludedNotOffered,
      excludedTpp: stats.excludedTpp,
      returned: stats.returned,
    });

    return {
      vacancies,
      stats,
      errors,
    };
  }
}
