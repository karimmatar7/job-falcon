import { vacancySchema } from '../models/vacancy.js';
import type { Vacancy } from '../models/vacancy.js';
import { computeMatchScore, explainMatch } from './relevanceScoring.js';
import type { Profile } from './relevanceScoring.js';
import { findDuplicates, isTppExcluded } from './deduplication.js';
import { assessExpiry } from './freshness.js';
import { assessLocationEligibility } from './relevanceScoring.js';
import { deriveEvidenceState } from './sponsorship.js';
import { assessPaidTraining } from './listingQuality.js';
import { validateApplicationUrl } from './applicationUrl.js';
import { isClearlySeniorTitle, requestsSeniorRoles } from './seniority.js';
import { NullSponsorRegister } from './sponsorRegister.js';
import type { SponsorRegister, SponsorRegisterResult } from './sponsorRegister.js';
import { employerVerificationTarget, resolveEmployerIdentity } from './employerIdentity.js';
import type { EmployerIdentity } from './employerIdentity.js';
import { createDefaultSources } from './sources/defaults.js';
import type { JobSource } from './sources/base.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

export interface JobSearchQuery {
  readonly keywords?: string[];
  readonly location?: string;
  readonly limit?: number;
}

/** Per-source outcome recorded for the coverage note shown to the user. */
export interface SourceStat {
  name: string;
  status: 'ok' | 'failed' | 'disabled';
  fetched: number;
  parsed: number;
  error?: string;
}

export interface JobSearchStats {
  fetched: number;
  parsed: number;
  excludedInvalid: number;
  /** Stale listings (explicitly closed or older than the freshness window). */
  excludedClosed: number;
  /**
   * Fee-charging training/placement adverts (self-funded programmes, paid
   * bootcamps) that are not paid employment and so are not job results.
   */
  excludedPaidTraining: number;
  /**
   * Clearly senior roles (Lead, Principal, Staff, Head of Engineering,
   * Engineering Manager, Director, C-suite, architect-level) excluded from the
   * default junior-role shortlist because the user did not request senior roles.
   */
  excludedSenior: number;
  /** Listings whose stated location appears to exclude UK-based candidates. */
  excludedIneligibleLocation: number;
  excludedNotOffered: number;
  excludedDuplicates: number;
  excludedTpp: number;
  /**
   * Unclear, open, UK-eligible vacancies whose match score met the alternative
   * threshold but exceeded the result cap, so they were not shown.
   */
  excludedUnclear: number;
  /**
   * Unclear, open, UK-eligible vacancies dropped for scoring below the
   * alternative relevance threshold, recorded so the coverage note reconciles.
   */
  excludedLowRelevance: number;
  /** Vacancies returned with explicit role-level sponsorship evidence. */
  confirmed: number;
  /**
   * Confirmed vacancies that were real results but exceeded the `/search`
   * limit, so they were not displayed. Recorded so the coverage note
   * reconciles: these are not lost, just not shown.
   */
  excludedConfirmedOverLimit: number;
  /** Alternatives shown where an authoritative register verified the employer. */
  employerVerifiedAlternatives: number;
  /** Additional relevant vacancies shown as "other opportunities" (sponsorship unconfirmed). */
  alternatives: number;
  /** Total vacancies returned (confirmed + alternatives). */
  returned: number;
  /** Per-source coverage, so the reply never claims an exhaustive search. */
  sources: SourceStat[];
}

/**
 * Hard cap on the number of unconfirmed alternatives appended to a result set.
 * The `/search` limit still applies on top of this: alternatives are only ever
 * taken from the slots left after confirmed vacancies, so a small `limit` keeps
 * working exactly as before.
 */
export const MAX_ALTERNATIVES = 5;

/** Alternatives below this relevance score are not shown (avoids padding the shortlist). */
export const MIN_ALTERNATIVE_SCORE = 25;

export interface JobSearchOptions {
  readonly now?: () => Date;
  readonly maxAgeDays?: number;
  readonly minAlternativeScore?: number;
  /**
   * Emit one info log per listing decision (opt-in, off by default). Intended
   * for auditing why listings were excluded; never logs descriptions or secrets.
   */
  readonly debugDecisions?: boolean;
}

export interface JobSearchResult {
  readonly vacancies: Vacancy[];
  readonly stats: JobSearchStats;
  readonly errors: string[];
}

/**
 * Compact default source query used when the user supplies no keywords.
 *
 * Adzuna's `what` is matched as a single query string, so sending a long list
 * of skills (the previous behaviour) matched nothing and produced 0 results.
 * A short role phrase returns real UK listings; the user's skills still drive
 * relevance ranking via {@link PROFILE} below.
 */
export const DEFAULT_KEYWORDS = ['software developer'];

const PROFILE: Profile = {
  skills: [
    'javascript',
    'typescript',
    'react',
    'web development',
    'sql',
    'drupal',
    'testing',
    'supabase',
    'figma',
    'adobe',
    'arduino',
    'raspberry',
    'ai tools',
  ],
  locations: ['barnsley', 'sheffield', 'leeds', 'manchester', 'yorkshire'],
};

export class RealJobSearchService {
  private readonly sources: readonly JobSource[];
  private readonly logger: Logger;
  private readonly sponsorRegister: SponsorRegister;
  private readonly now: () => Date;
  private readonly maxAgeDays: number;
  private readonly minAlternativeScore: number;
  private readonly debugDecisions: boolean;

  constructor(
    sources?: readonly JobSource[],
    logger: Logger = createLogger(),
    sponsorRegister: SponsorRegister = new NullSponsorRegister(),
    options: JobSearchOptions = {},
  ) {
    this.logger = logger;
    this.sources = sources ?? createDefaultSources(logger);
    this.sponsorRegister = sponsorRegister;
    this.now = options.now ?? (() => new Date());
    this.maxAgeDays = options.maxAgeDays ?? 45;
    this.minAlternativeScore = options.minAlternativeScore ?? MIN_ALTERNATIVE_SCORE;
    this.debugDecisions = options.debugDecisions === true;
  }

  async search(query: JobSearchQuery = {}): Promise<JobSearchResult> {
    const keywords = query.keywords && query.keywords.length > 0 ? query.keywords : DEFAULT_KEYWORDS;
    const limit = Math.min(query.limit ?? 5, 20);

    const fetched: Vacancy[] = [];
    const parsed: Vacancy[] = [];
    const errors: string[] = [];
    const sourceStats: SourceStat[] = [];

    for (const source of this.sources) {
      if (!source.enabled) {
        this.logger.info('Job source disabled; skipping', { source: source.name });
        sourceStats.push({ name: source.name, status: 'disabled', fetched: 0, parsed: 0 });
        continue;
      }

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
          }
        }

        sourceStats.push({
          name: source.name,
          status: 'ok',
          fetched: results.length,
          parsed: valid,
        });

        this.logger.info('Job source fetched listings', {
          source: source.name,
          fetched: results.length,
          parsed: valid,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${source.name}: ${msg}`);
        sourceStats.push({
          name: source.name,
          status: 'failed',
          fetched: 0,
          parsed: 0,
          error: msg,
        });
        this.logger.warn('Job source failed', { source: source.name, message: msg });
      }
    }

    const stats: JobSearchStats = {
      fetched: fetched.length,
      parsed: parsed.length,
      excludedInvalid: fetched.length - parsed.length,
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
      sources: sourceStats,
    };

    // Sponsorship classification and relevance scoring stay independent: a
    // vacancy's status is decided by `classifySponsorship` in the source
    // adapter, never by its relevance score.
    const confirmedCandidates: Vacancy[] = [];
    const unclearCandidates: Vacancy[] = [];
    const exclusionReasons: string[] = [];

    for (const vacancy of parsed) {
      const expiry = assessExpiry(vacancy, this.now(), this.maxAgeDays);
      if (expiry.expired) {
        stats.excludedClosed++;
        exclusionReasons.push(`${vacancy.id}: closed (${expiry.reason ?? 'expired'})`);
        this.traceDecision('excluded_expired', vacancy, { reason: expiry.reason ?? 'expired' });
        continue;
      }

      const training = assessPaidTraining(vacancy);
      if (training.isPaidTraining) {
        stats.excludedPaidTraining++;
        exclusionReasons.push(
          `${vacancy.id}: paid training/placement advert (${training.reason ?? 'charges fees'})`,
        );
        this.traceDecision('excluded_paid_training', vacancy, { reason: training.reason ?? 'charges fees' });
        continue;
      }

      // The default shortlist targets junior/graduate roles. Clearly senior
      // titles are excluded unless the user explicitly asked for senior roles.
      if (isClearlySeniorTitle(vacancy.title) && !requestsSeniorRoles(keywords)) {
        stats.excludedSenior++;
        exclusionReasons.push(`${vacancy.id}: clearly senior role (${vacancy.title})`);
        this.traceDecision('excluded_senior', vacancy);
        continue;
      }

      if (vacancy.vacancySponsorshipStatus === 'not_offered') {
        stats.excludedNotOffered++;
        this.traceDecision('excluded_not_offered', vacancy);
        continue;
      }

      if (isTppExcluded(vacancy)) {
        stats.excludedTpp++;
        this.traceDecision('excluded_tpp', vacancy);
        continue;
      }

      const eligibility = assessLocationEligibility(vacancy.location);
      if (eligibility === 'ineligible') {
        stats.excludedIneligibleLocation++;
        exclusionReasons.push(`${vacancy.id}: location excludes UK (${vacancy.location})`);
        this.traceDecision('excluded_location', vacancy, { reason: vacancy.location });
        continue;
      }

      const withEligibility: Vacancy = { ...vacancy, locationEligibility: eligibility };
      const identity = resolveEmployerIdentity({
        employer: vacancy.employer,
        title: vacancy.title,
        description: vacancy.description,
      });
      const withIdentity: Vacancy = {
        ...withEligibility,
        employerType: identity.advertiserRole,
        ...(identity.endEmployer === undefined ? {} : { endEmployer: identity.endEmployer }),
      };
      if (vacancy.vacancySponsorshipStatus === 'confirmed') {
        confirmedCandidates.push(withIdentity);
        this.traceDecision('candidate_confirmed', vacancy, { locationEligibility: eligibility });
      } else {
        unclearCandidates.push(withIdentity);
        this.traceDecision('candidate_unclear', vacancy, { locationEligibility: eligibility });
      }
    }

    this.logger.info(
      this.sponsorRegister.enabled
        ? "Employer register verification enabled"
        : "Employer register verification disabled; employer licence will not be checked",
      { register: this.sponsorRegister.name },
    );

    const verifiedCandidates = await this.verifyEmployers([
      ...confirmedCandidates,
      ...unclearCandidates,
    ]);

    // De-duplicate across both groups, confirmed first, so a confirmed listing
    // always wins over an unclear duplicate of the same vacancy.
    const dupResult = findDuplicates(verifiedCandidates);
    stats.excludedDuplicates = dupResult.duplicates.length;
    const deduped = dupResult.kept;

    // Validate application links before display: a missing or invalid URL is
    // never silently replaced with a source homepage. Post-dedup on purpose, so
    // the URL-based de-duplication still sees the raw source URLs.
    const withValidatedLinks = deduped.map(applyApplicationUrlValidation);

    if (this.debugDecisions) {
      for (const { original, duplicate } of dupResult.duplicates) {
        this.logger.info('Job search decision: duplicate', {
          stage: 'duplicate',
          kept: describeListing(original),
          dropped: describeListing(duplicate),
        });
      }
    }

    const scoredConfirmed = scoreAndRank(
      withValidatedLinks.filter(v => v.vacancySponsorshipStatus === 'confirmed'),
    );
    const scoredUnclear = scoreAndRank(
      withValidatedLinks.filter(v => v.vacancySponsorshipStatus === 'unclear'),
    );

    const confirmed = scoredConfirmed.slice(0, limit);
    const rankedAlternatives = scoredUnclear.filter(v => (v.matchScore ?? 0) >= this.minAlternativeScore);
    const alternativeSlots = Math.max(0, Math.min(MAX_ALTERNATIVES, limit - confirmed.length));
    const alternatives = rankedAlternatives.slice(0, alternativeSlots).map(addFallbackReason);

    stats.confirmed = confirmed.length;
    stats.excludedConfirmedOverLimit = Math.max(0, scoredConfirmed.length - confirmed.length);
    stats.alternatives = alternatives.length;
    stats.employerVerifiedAlternatives = alternatives.filter(
      v => v.employerSponsorshipVerified === true,
    ).length;
    stats.excludedUnclear = rankedAlternatives.length - alternatives.length;
    stats.excludedLowRelevance = scoredUnclear.length - rankedAlternatives.length;
    stats.returned = confirmed.length + alternatives.length;

    if (this.debugDecisions) {
      const shownIds = new Set(alternatives.map(v => v.id));
      for (const vacancy of scoredUnclear) {
        const score = vacancy.matchScore ?? 0;
        const stage = shownIds.has(vacancy.id)
          ? 'shown_alternative'
          : score < this.minAlternativeScore
            ? 'excluded_below_threshold'
            : 'excluded_over_cap';
        this.traceDecision(stage, vacancy, { matchScore: score });
      }
      const shownConfirmedIds = new Set(confirmed.map(v => v.id));
      for (const vacancy of scoredConfirmed) {
        const stage = shownConfirmedIds.has(vacancy.id)
          ? 'shown_confirmed'
          : 'excluded_over_limit_confirmed';
        this.traceDecision(stage, vacancy, { matchScore: vacancy.matchScore ?? 0 });
      }
    }

    const vacancies = [...confirmed, ...alternatives];

    this.logger.info('Job search pipeline summary', {
      fetched: stats.fetched,
      parsed: stats.parsed,
      excludedInvalid: stats.excludedInvalid,
      rejectedClosed: stats.excludedClosed,
      rejectedIneligibleLocation: stats.excludedIneligibleLocation,
      rejectedPaidTraining: stats.excludedPaidTraining,
      rejectedSenior: stats.excludedSenior,
      rejectedDuplicates: stats.excludedDuplicates,
      rejectedNotOffered: stats.excludedNotOffered,
      excludedTpp: stats.excludedTpp,
      confirmed: stats.confirmed,
      excludedConfirmedOverLimit: stats.excludedConfirmedOverLimit,
      alternatives: stats.alternatives,
      excludedUnclear: stats.excludedUnclear,
      excludedLowRelevance: stats.excludedLowRelevance,
      returned: stats.returned,
      sources: sourceStats,
      ...(exclusionReasons.length > 0 ? { exclusionReasons } : {}),
    });

    return {
      vacancies,
      stats,
      errors,
    };
  }

  /**
   * Emit one structured decision log per listing when `debugDecisions` is on.
   * Lists identity and stage only (never descriptions or secrets) so an audit
   * can reconstruct exactly why each listing was kept or dropped.
   */
  private traceDecision(stage: string, vacancy: Vacancy, extra: Record<string, unknown> = {}): void {
    if (!this.debugDecisions) return;
    this.logger.info('Job search decision', {
      stage,
      ...describeListing(vacancy),
      ...extra,
    });
  }

  /**
   * Record the employer-register outcome for every candidate (once per
   * employer). The outcome is stored as its own fact and never changes the
   * vacancy verdict: a `verified` licence never makes a vacancy confirmed.
   *
   * For a vacancy advertised by a recruitment agency the only meaningful
   * register target is the *end employer*. When the agency does not name its
   * client the target is unknown, so nothing is checked or claimed (recorded as
   * `not_checked`): an agency's own licence proves nothing about the role it is
   * advertising.
   */
  private async verifyEmployers(vacancies: readonly Vacancy[]): Promise<Vacancy[]> {
    if (!this.sponsorRegister.enabled) return [...vacancies];

    const cache = new Map<string, SponsorRegisterResult>();
    const verified: Vacancy[] = [];

    for (const vacancy of vacancies) {
      const identity = resolveEmployerIdentity({
        employer: vacancy.employer,
        title: vacancy.title,
        description: vacancy.description,
      });
      const target = employerVerificationTarget(identity);

      // Recruiter with an unnamed end employer: record that nothing could be
      // checked rather than checking (or claiming) the agency's own licence.
      if (target === undefined) {
        this.logger.info(
          'Sponsor register: employer not checked (recruiter with unknown end employer)',
          { vacancyId: vacancy.id, advertiser: identity.advertiserRole },
        );
        verified.push({
          ...vacancy,
          employerRegisterStatus: 'not_checked',
          employerType: identity.advertiserRole,
          ...(identity.endEmployer === undefined ? {} : { endEmployer: identity.endEmployer }),
        });
        continue;
      }

      const key = target.trim().toLowerCase();
      let result = cache.get(key);
      if (result === undefined) {
        result = await this.sponsorRegister.isLicensedSponsor(target);
        cache.set(key, result);
      }

      this.logger.info('Sponsor register: lookup outcome', {
        vacancyId: vacancy.id,
        employer: target,
        status: result.status,
        ...(result.matchedEntry === undefined ? {} : { matchedEntry: result.matchedEntry }),
        ...(result.registerUpdatedAt === undefined
          ? {}
          : { registerUpdatedAt: result.registerUpdatedAt }),
      });

      verified.push(applyRegisterOutcome(vacancy, identity, target, result));
    }

    return verified;
  }
}

/** Identity fields for decision logs; deliberately excludes free-text description. */
function describeListing(vacancy: Vacancy): {
  id: string;
  source?: string;
  employer: string;
  title: string;
  location: string;
  url?: string;
} {
  const url = vacancy.applicationUrl ?? vacancy.sourceUrl;
  return {
    id: vacancy.id,
    ...(vacancy.source === undefined ? {} : { source: vacancy.source }),
    employer: vacancy.employer,
    title: vacancy.title,
    location: vacancy.location,
    ...(url === undefined ? {} : { url }),
  };
}

/**
 * Drop any application URL that is missing or not a direct listing link, and
 * record why it is unavailable. A source homepage is never shown as the apply
 * link, and no other URL is substituted in its place.
 */
function applyApplicationUrlValidation(vacancy: Vacancy): Vacancy {
  const check = validateApplicationUrl(vacancy.applicationUrl);
  const next: Vacancy = { ...vacancy };

  if (check.status === 'direct' && check.url !== undefined) {
    next.applicationUrl = check.url;
    return next;
  }

  delete next.applicationUrl;
  if (check.note !== undefined) {
    next.applicationUrlNote = vacancy.applicationUrlNote ?? check.note;
  }
  return next;
}

/** Attach a register outcome without ever touching the sponsorship verdict. */
function applyRegisterOutcome(
  vacancy: Vacancy,
  identity: EmployerIdentity,
  target: string,
  result: SponsorRegisterResult,
): Vacancy {
  const checked: Vacancy = {
    ...vacancy,
    employerType: identity.advertiserRole,
    ...(identity.endEmployer === undefined ? {} : { endEmployer: identity.endEmployer }),
    employerRegisterStatus: result.status,
    sponsorRegisterStatus: result.status,
    ...(result.sourceUrl.length === 0 ? {} : { sponsorRegisterUrl: result.sourceUrl }),
    sponsorRegisterCheckedAt: result.checkedAt,
    ...(result.retrievedAt === undefined ? {} : { sponsorRegisterRetrievedAt: result.retrievedAt }),
    ...(result.registerUpdatedAt === undefined
      ? {}
      : { sponsorRegisterUpdatedAt: result.registerUpdatedAt }),
    employerVerificationTarget: result.matchedEntry ?? target,
  };

  // A verified licence is a separate capability fact; it never upgrades the
  // vacancy-level sponsorship status.
  if (result.status === 'verified') {
    return {
      ...checked,
      employerSponsorshipVerified: true,
      employerSponsorLicence: 'yes',
      employerLicenceEvidence: result.evidence,
    };
  }
  return checked;
}

function addFallbackReason(vacancy: Vacancy): Vacancy {
  const state = deriveEvidenceState(vacancy);
  const sponsorshipNote =
    state === 'employer_sponsor_verified'
      ? 'the employer is a licensed sponsor, but this specific vacancy does not confirm sponsorship'
      : 'this listing contains no vacancy-specific sponsorship evidence';
  const explanation = vacancy.matchExplanation ?? `Score ${vacancy.matchScore ?? 0}/100`;
  return {
    ...vacancy,
    fallbackReason: `${explanation}. Included because it matches your profile; ${sponsorshipNote}.`,
    evidenceState: state,
  };
}

function scoreAndRank(vacancies: readonly Vacancy[]): Vacancy[] {
  return vacancies
    .map(v => {
      const score = computeMatchScore(v, PROFILE);
      return {
        ...v,
        matchScore: score,
        matchExplanation: explainMatch(v, score, PROFILE),
        evidenceState: deriveEvidenceState(v),
      };
    })
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
}
