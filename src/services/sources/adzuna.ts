import type { Vacancy } from '../../models/vacancy.js';
import { classifySponsorship } from '../sponsorship.js';
import { validateApplicationUrl } from '../applicationUrl.js';
import { createLogger } from '../../utils/logger.js';
import type { Logger } from '../../utils/logger.js';
import { SourceError } from './base.js';
import type { JobSource, SourceQuery } from './base.js';
import { stripHtml } from './text.js';

/**
 * Adzuna job-search API (`https://api.adzuna.com/v1/api`).
 *
 * Verified against the official documentation (developer.adzuna.com):
 * - Endpoint: `GET /v1/api/jobs/{country}/search/{page}`; the page number is
 *   part of the URL path (1-based).
 * - Auth: obligatory `app_id` and `app_key` query parameters; invalid or
 *   missing credentials return HTTP 401/403.
 * - `results_per_page`: 1-50 (default 20). `where` filters by location,
 *   `what` by keywords, `max_days_old` by publication age.
 * - Error responses carry a non-2xx HTTP status plus a serialised exception.
 * - Rate limits (ToS): 25 hits/minute, 250/day, 1000/week, 2500/month.
 *   The adapter enforces a polite 1-second minimum interval between requests
 *   and paginates conservatively (default 2 pages per search).
 *
 * Unlike Remotive this source is UK-focused and honours keyword/location
 * queries. It is only constructed when valid credentials are configured, so
 * without a key there are no network calls and no claims.
 */
export interface AdzunaSourceOptions {
  readonly appId: string;
  readonly appKey: string;
  /** ISO 2-letter country code understood by Adzuna; defaults to `gb`. */
  readonly country?: string;
  /** Results per page, clamped to 1-50. Defaults to 20 (API default). */
  readonly resultsPerPage?: number;
  /** Number of result pages to walk (1-10). Defaults to 2. */
  readonly maxPages?: number;
  /** Restrict to listings published within the last N days (0 disables). */
  readonly maxDaysOld?: number;
}

const ENDPOINT_BASE = 'https://api.adzuna.com/v1/api/jobs';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_MS = 1_000;
export const DEFAULT_RESULTS_PER_PAGE = 20;
export const DEFAULT_MAX_PAGES = 2;
export const DEFAULT_MAX_DAYS_OLD = 45;
const MAX_RESULTS_PER_PAGE = 50;
const MAX_PAGES = 10;

let lastRequestAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** Enforces a polite minimum interval between requests to the same host. */
async function enforceRateLimit(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) {
    lastRequestAt = Date.now();
    return;
  }
  const wait = lastRequestAt + minIntervalMs - Date.now();
  if (wait > 0) await delay(wait);
  lastRequestAt = Date.now();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class AdzunaSource implements JobSource {
  readonly name = 'adzuna';
  readonly enabled = true;

  constructor(
    private readonly options: AdzunaSourceOptions,
    private readonly logger: Logger = createLogger(),
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly rateLimitMs: number = DEFAULT_RATE_LIMIT_MS,
  ) {}

  async search(query: SourceQuery): Promise<Vacancy[]> {
    const resultsPerPage = clamp(
      this.options.resultsPerPage ?? DEFAULT_RESULTS_PER_PAGE,
      1,
      MAX_RESULTS_PER_PAGE,
    );
    const maxPages = clamp(this.options.maxPages ?? DEFAULT_MAX_PAGES, 1, MAX_PAGES);
    const vacancies: Vacancy[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const url = this.buildUrl(query, page, resultsPerPage);

      let response: Response;
      try {
        response = await this.request(url);
      } catch (error) {
        if (page === 1) throw error;
        // Later pages are best-effort: return what we have rather than losing
        // an entire search because page 2+ failed.
        this.logger.warn('Adzuna pagination page failed; using results so far', {
          source: this.name,
          page,
          collected: vacancies.length,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      const payload = await this.readJson(response);
      const received = extractResults(payload);
      this.logger.info('Job source records received', {
        source: this.name,
        status: response.status,
        page,
        records: received.length,
      });

      const before = vacancies.length;
      for (const record of received) {
        const mapped = mapAdzunaJob(record);
        if (mapped !== null) vacancies.push(mapped);
      }

      this.logger.info('Job source page parsed', {
        source: this.name,
        page,
        received: received.length,
        parsed: vacancies.length - before,
      });

      if (received.length === 0 || received.length < resultsPerPage) break;
    }

    this.logger.info('Job source parsed listings', {
      source: this.name,
      vacancies: vacancies.length,
    });

    return vacancies;
  }

  private buildUrl(query: SourceQuery, page: number, resultsPerPage: number): string {
    const country = (this.options.country ?? 'gb').toLowerCase();
    const params = new URLSearchParams({
      app_id: this.options.appId,
      app_key: this.options.appKey,
      results_per_page: String(resultsPerPage),
      'content-type': 'application/json',
    });
    const what = query.keywords?.filter(k => k.trim().length > 0).join(' ').trim() ?? '';
    if (what.length > 0) params.set('what', what);
    if (query.location !== undefined && query.location.trim().length > 0) {
      params.set('where', query.location.trim());
    }
    const maxDaysOld = this.options.maxDaysOld ?? DEFAULT_MAX_DAYS_OLD;
    if (maxDaysOld > 0) params.set('max_days_old', String(maxDaysOld));
    return `${ENDPOINT_BASE}/${country}/search/${page}?${params.toString()}`;
  }

  private async request(url: string): Promise<Response> {
    await enforceRateLimit(this.rateLimitMs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      const reason = describeError(error);
      this.logger.warn('Job source request failed', { source: this.name, reason });
      throw new SourceError(reason, this.name);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const code = await this.readErrorCode(response);
      const suffix =
        response.status === 401 || response.status === 403
          ? ' (authentication failed)'
          : response.status === 429
            ? ' (rate limited)'
            : code !== null
              ? ` (${code})`
              : '';
      this.logger.warn('Job source returned non-OK status', {
        source: this.name,
        status: response.status,
        ...(code !== null ? { code } : {}),
      });
      throw new SourceError(`HTTP ${response.status}${suffix}`, this.name);
    }

    this.logger.info('Job source request succeeded', { source: this.name, status: response.status });
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new SourceError(describeError(error), this.name);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      this.logger.warn('Job source returned malformed JSON', { source: this.name });
      throw new SourceError('malformed JSON response', this.name);
    }
  }

  /** Extract the upstream exception code from a non-OK body when possible. */
  private async readErrorCode(response: Response): Promise<string | null> {
    if (response.bodyUsed) return null;
    try {
      const text = await response.text();
      const payload = JSON.parse(text) as unknown;
      if (payload !== null && typeof payload === 'object') {
        const record = payload as { code?: unknown; error?: { code?: unknown } };
        if (typeof record.code === 'string' && record.code.length > 0) return record.code;
        if (typeof record.error?.code === 'string' && record.error.code.length > 0) {
          return record.error.code;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

function extractResults(payload: unknown): unknown[] {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray((payload as { results?: unknown }).results)
  ) {
    return (payload as { results: unknown[] }).results;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readDisplayName(value: unknown): string {
  const record = asRecord(value);
  const name = record?.display_name;
  return typeof name === 'string' ? name.trim() : '';
}

function readSalary(source: Record<string, unknown>): string {
  const min = typeof source.salary_min === 'number' ? source.salary_min : null;
  const max = typeof source.salary_max === 'number' ? source.salary_max : null;
  if (min === null && max === null) return '';
  const fmt = (value: number): string =>
    `£${value.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
  if (min !== null && max !== null && min !== max) return `${fmt(min)} - ${fmt(max)}`;
  return fmt(min ?? (max as number));
}

function mapAdzunaJob(record: unknown): Vacancy | null {
  const source = asRecord(record);
  if (source === null) return null;

  const url = typeof source.redirect_url === 'string' ? source.redirect_url.trim() : '';
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const employer = readDisplayName(source.company);
  if (!isHttpUrl(url) || title.length === 0 || employer.length === 0) return null;

  const location = readDisplayName(source.location) || 'United Kingdom';
  const description = typeof source.description === 'string' ? stripHtml(source.description) : '';
  const datePosted = typeof source.created === 'string' ? source.created : '';
  const id = source.id === undefined || source.id === null ? url : String(source.id);
  const salary = readSalary(source);

  const evidence = classifySponsorship({ title, employer, description, sourceUrl: url });
  const application = validateApplicationUrl(url);

  const vacancy: Vacancy = {
    id: `adzuna-${id}`,
    title,
    employer,
    location,
    source: 'adzuna',
    sourceUrl: url,
    ...(application.status === 'direct' && application.url !== undefined
      ? { applicationUrl: application.url }
      : { applicationUrlNote: application.note ?? 'no direct listing URL was provided' }),
    vacancySponsorshipStatus: evidence.status,
    sponsorshipEvidence: evidence.evidence,
    sponsorshipEvidenceUrl: evidence.evidenceUrl,
    sponsorshipEvidenceSnippet: evidence.evidenceSnippet,
    sponsorshipEvidenceReason: evidence.reason,
    employerSponsorLicence: evidence.employerLicenceStatus,
    employerLicenceEvidence: evidence.employerLicenceEvidence,
    lastVerifiedAt: evidence.lastVerifiedAt,
    ...(description.length > 0 ? { description } : {}),
    ...(salary.length > 0 ? { salary } : {}),
    ...(datePosted.length > 0 ? { datePosted } : {}),
  };

  return vacancy;
}

function isHttpUrl(value: string): boolean {
  if (value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return 'request timed out';
    }
    return error.message;
  }
  return String(error);
}