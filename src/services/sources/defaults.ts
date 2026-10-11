import type { JobSource } from './base.js';
import { AdzunaSource, type AdzunaSourceOptions } from './adzuna.js';
import { DummySource } from './dummy.js';
import { RemotiveSource } from './remotive.js';
import { createLogger } from '../../utils/logger.js';
import type { Logger } from '../../utils/logger.js';

/**
 * True only when BOTH Adzuna credentials are present and non-empty. Adzuna's
 * search endpoint requires both `app_id` and `app_key`, so a half-configured
 * pair must never activate the source or make unauthenticated calls.
 */
export function isAdzunaConfigured(env: Record<string, string | undefined>): boolean {
  return (
    env.ADZUNA_APP_ID !== undefined &&
    env.ADZUNA_APP_KEY !== undefined &&
    env.ADZUNA_APP_ID.trim().length > 0 &&
    env.ADZUNA_APP_KEY.trim().length > 0
  );
}

/**
 * Build the source options from the environment, or `null` when Adzuna cannot
 * be used. `ADZUNA_COUNTRY` defaults to `gb`; `ADZUNA_MAX_PAGES` (1-10) trades
 * coverage against the free-tier rate limits (defaults to 2).
 */
export function buildAdzunaOptions(
  env: Record<string, string | undefined>,
): AdzunaSourceOptions | null {
  const appId = (env.ADZUNA_APP_ID ?? '').trim();
  const appKey = (env.ADZUNA_APP_KEY ?? '').trim();
  if (appId.length === 0 || appKey.length === 0) return null;

  const country = env.ADZUNA_COUNTRY?.trim();
  const maxPagesRaw = env.ADZUNA_MAX_PAGES?.trim();
  const maxPages =
    maxPagesRaw !== undefined && maxPagesRaw.length > 0 && /^\d+$/.test(maxPagesRaw)
      ? Math.max(1, Math.min(10, Number(maxPagesRaw)))
      : undefined;

  const options: AdzunaSourceOptions = {
    appId,
    appKey,
    ...(country !== undefined && country.length > 0 ? { country } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
  };
  return options;
}

/**
 * Build the default source list.
 *
 * Remotive is always on. Adzuna (UK-focused, query-aware) is added only when
 * both `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` are configured, so the bot never
 * makes calls it cannot authenticate and never claims coverage it does not have.
 * If Adzuna later fails at runtime the pipeline isolates the failure and keeps
 * the remaining sources working.
 */
export function createDefaultSources(
  logger: Logger = createLogger(),
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): readonly JobSource[] {
  const sources: JobSource[] = [new RemotiveSource(logger, fetcher)];

  const options = buildAdzunaOptions(env);
  if (options !== null) {
    sources.push(new AdzunaSource(options, logger, fetcher));
  } else {
    const hasId = (env.ADZUNA_APP_ID ?? '').trim().length > 0;
    const hasKey = (env.ADZUNA_APP_KEY ?? '').trim().length > 0;
    if (hasId !== hasKey) {
      logger.warn(
        'Adzuna source not enabled: both ADZUNA_APP_ID and ADZUNA_APP_KEY are required',
        { source: 'defaults' },
      );
    }
  }

  sources.push(new DummySource());
  return sources;
}