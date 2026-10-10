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
}

export interface JobSearchStats {
  fetched: number;
  parsed: number;
  excludedInvalid: number;
  excludedClosed: number;
  excludedNotOffered: number;
  excludedDuplicates: number;
  excludedTpp: number;
  /** Relevant, open vacancies left over after the alternative cap; not shown. */
  excludedUnclear: number;
  /** Vacancies returned with explicit role-level sponsorship evidence. */
  confirmed: number;
  /** Additional relevant vacancies shown as "other opportunities" (sponsorship unconfirmed). */
  alternatives: number;
  /** Total vacancies returned (confirmed + alternatives). */
  returned: number;
}

/** Hard cap on the number of unconfirmed alternatives appended to a result set. */
export const MAX_ALTERNATIVES = 2;

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
      excludedNotOffered: 0,
      excludedDuplicates: 0,
      excludedTpp: 0,
      excludedUnclear: 0,
      confirmed: 0,
      alternatives: 0,
      returned: 0,
    };

    // Sponsorship classification and relevance scoring stay independent: a
    // vacancy's status is decided by `classifySponsorship` in the source
    // adapter, never by its relevance score.
    const confirmedCandidates: Vacancy[] = [];
    const unclearCandidates: Vacancy[] = [];

    for (const vacancy of parsed) {
      if (vacancy.vacancySponsorshipStatus === 'not_offered') {
        stats.excludedNotOffered++;
        continue;
      }
      if (isTppExcluded(vacancy)) {
        stats.excludedTpp++;
        continue;
      }
      if (vacancy.vacancySponsorshipStatus === 'confirmed') {
        confirmedCandidates.push(vacancy);
      } else {
        unclearCandidates.push(vacancy);
      }
    }

    // De-duplicate across both groups, confirmed first, so a confirmed listing
    // always wins over an unclear duplicate of the same vacancy.
    const dupResult = findDuplicates([...confirmedCandidates, ...unclearCandidates]);
    stats.excludedDuplicates = dupResult.duplicates.length;
    const deduped = dupResult.kept;

    const scoredConfirmed = scoreAndRank(
      deduped.filter(v => v.vacancySponsorshipStatus === 'confirmed'),
    );
    const scoredUnclear = scoreAndRank(
      deduped.filter(v => v.vacancySponsorshipStatus === 'unclear'),
    );

    const confirmed = scoredConfirmed.slice(0, limit);
    const alternativeSlots = Math.max(0, Math.min(MAX_ALTERNATIVES, limit - confirmed.length));
    const alternatives = scoredUnclear.slice(0, alternativeSlots);

    stats.confirmed = confirmed.length;
    stats.alternatives = alternatives.length;
    stats.excludedUnclear = scoredUnclear.length - alternatives.length;
    stats.returned = confirmed.length + alternatives.length;

    const vacancies = [...confirmed, ...alternatives];

    this.logger.info('Job search pipeline summary', {
      sourcesAttempted,
      sourcesFailed,
      fetched: stats.fetched,
      parsed: stats.parsed,
      excludedInvalid: stats.excludedInvalid,
      rejectedClosed: stats.excludedClosed,
      rejectedDuplicates: stats.excludedDuplicates,
      rejectedNotOffered: stats.excludedNotOffered,
      excludedTpp: stats.excludedTpp,
      confirmed: stats.confirmed,
      alternatives: stats.alternatives,
      excludedUnclear: stats.excludedUnclear,
      returned: stats.returned,
    });

    return {
      vacancies,
      stats,
      errors,
    };
  }
}

function scoreAndRank(vacancies: readonly Vacancy[]): Vacancy[] {
  return vacancies
    .map(v => {
      const score = computeMatchScore(v, PROFILE);
      return {
        ...v,
        matchScore: score,
        matchExplanation: explainMatch(v, score, PROFILE),
      };
    })
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
}
