import type { Logger } from "../utils/logger.js";
import type { DueRunOutcome } from "../services/scheduling/scheduler.js";
import type { RunTrigger } from "../services/state/stateStore.js";
import { CRON_AUTHORIZATION_HEADER, verifyCronAuthorization } from "../config/cron.js";

/**
 * The slice of the scheduler the endpoint needs. Kept narrow so the HTTP layer
 * can be unit-tested with a fake and no Telegram/Adzuna access.
 */
export interface DueScheduler {
  runIfDue(trigger?: RunTrigger): Promise<DueRunOutcome>;
}

/** Minimal Node-style request/response shapes (matches Vercel's Node runtime). */
export interface CronRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface CronResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): CronResponse;
  json(body: unknown): unknown;
}

export interface ScheduledSearchEndpointDeps {
  readonly scheduler: DueScheduler;
  readonly logger: Logger;
  /** Shared secret; the endpoint returns 401 when it is unset or mismatched. */
  readonly secret: string | undefined;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Build the handler for `GET/POST /api/scheduled-search`.
 *
 * The route is protected by `CRON_SECRET` and is safe to call as often as a
 * scheduler likes: {@link DueScheduler.runIfDue} only runs the search when it is
 * actually due, so repeated or overlapping triggers cannot double-alert. A
 * non-due call still returns 200 so the scheduler is not asked to retry.
 */
export function createScheduledSearchEndpoint(deps: ScheduledSearchEndpointDeps) {
  return async function scheduledSearchEndpoint(
    req: CronRequest,
    res: CronResponse,
  ): Promise<void> {
    const authorization = readHeader(req.headers, CRON_AUTHORIZATION_HEADER);
    if (!verifyCronAuthorization(authorization, deps.secret)) {
      res.setHeader("www-authenticate", 'Bearer realm="scheduled-search"');
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    try {
      const outcome = await deps.scheduler.runIfDue("schedule");
      deps.logger.info("Scheduled search endpoint handled", {
        ran: outcome.ran,
        reason: outcome.reason,
      });
      res.status(200).json({
        ok: true,
        ran: outcome.ran,
        reason: outcome.reason,
        record: outcome.record ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error("Scheduled search endpoint failed", { message });
      res.status(500).json({ ok: false, error: "scheduled search failed" });
    }
  };
}
