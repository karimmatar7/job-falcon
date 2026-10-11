import type { Vacancy } from '../../models/vacancy.js';
import { vacancySchema } from '../../models/vacancy.js';
import { classifySponsorship } from '../sponsorship.js';
import { createLogger } from '../../utils/logger.js';
import type { Logger } from '../../utils/logger.js';
import { SourceError } from './base.js';
import type { JobSource, SourceQuery } from './base.js';
import { stripHtml } from './text.js';

/** Documented, public, keyless Remotive job API. */
const ENDPOINT = 'https://remotive.com/api/remote-jobs';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_MS = 1_000;
const MAX_RECORDS = 100;

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

export class RemotiveSource implements JobSource {
  readonly name = 'remotive';
  readonly enabled = true;

  constructor(
    private readonly logger: Logger = createLogger(),
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly rateLimitMs: number = DEFAULT_RATE_LIMIT_MS,
  ) {}

  async search(_query: SourceQuery): Promise<Vacancy[]> {
    const response = await this.request(ENDPOINT);
    const payload = await this.readJson(response);

    const received = extractJobs(payload).slice(0, MAX_RECORDS);
    this.logger.info('Job source records received', {
      source: this.name,
      status: response.status,
      records: received.length,
    });

    const vacancies: Vacancy[] = [];
    const rejected: Record<string, number> = {};

    for (const record of received) {
      const mapped = mapRemotiveJob(record);
      if (!mapped.ok) {
        rejected[mapped.reason] = (rejected[mapped.reason] ?? 0) + 1;
        continue;
      }
      const validation = vacancySchema.safeParse(mapped.vacancy);
      if (!validation.success) {
        rejected.schema = (rejected.schema ?? 0) + 1;
        continue;
      }
      vacancies.push(validation.data);
    }

    this.logger.info('Job source parsed listings', {
      source: this.name,
      received: received.length,
      parsed: vacancies.length,
      rejected,
    });

    return vacancies;
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
      this.logger.warn('Job source returned non-OK status', {
        source: this.name,
        status: response.status,
      });
      throw new SourceError(`HTTP ${response.status}`, this.name);
    }

    this.logger.info('Job source request succeeded', {
      source: this.name,
      status: response.status,
    });
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      const reason = describeError(error);
      this.logger.warn('Job source response body could not be read', {
        source: this.name,
        reason,
      });
      throw new SourceError(reason, this.name);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      this.logger.warn('Job source returned malformed JSON', { source: this.name });
      throw new SourceError('malformed JSON response', this.name);
    }
  }
}

function extractJobs(payload: unknown): unknown[] {
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { jobs?: unknown }).jobs)) {
    return (payload as { jobs: unknown[] }).jobs;
  }
  return [];
}

type MappedJob = { ok: true; vacancy: Vacancy } | { ok: false; reason: string };

function mapRemotiveJob(record: unknown): MappedJob {
  if (record === null || typeof record !== 'object') {
    return { ok: false, reason: 'not_an_object' };
  }

  const source = record as Record<string, unknown>;
  const url = typeof source.url === 'string' ? source.url : '';
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const employer = typeof source.company_name === 'string' ? source.company_name.trim() : '';

  if (!isHttpUrl(url)) return { ok: false, reason: 'missing_or_invalid_url' };
  if (title.length === 0) return { ok: false, reason: 'missing_title' };
  if (employer.length === 0) return { ok: false, reason: 'missing_employer' };

  const rawLocation =
    typeof source.candidate_required_location === 'string'
      ? source.candidate_required_location.trim()
      : '';
  const location = rawLocation.length > 0 ? rawLocation : 'Remote';
  const description = typeof source.description === 'string' ? stripHtml(source.description) : '';
  const salary = typeof source.salary === 'string' && source.salary.trim().length > 0 ? source.salary.trim() : '';
  const datePosted = typeof source.publication_date === 'string' ? source.publication_date : '';
  const id = source.id === undefined || source.id === null ? url : String(source.id);

  const evidence = classifySponsorship({ title, employer, description, sourceUrl: url });

  const vacancy: Vacancy = {
    id: `remotive-${id}`,
    title,
    employer,
    location,
    source: 'remotive',
    sourceUrl: url,
    applicationUrl: url,
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

  return { ok: true, vacancy };
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
