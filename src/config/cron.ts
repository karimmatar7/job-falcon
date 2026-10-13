import { timingSafeEqual } from "node:crypto";

/**
 * Authentication for the scheduled-search endpoint.
 *
 * Vercel sends the value of the `CRON_SECRET` environment variable as an
 * `Authorization: Bearer <secret>` header on every cron invocation. The same
 * convention works for any external scheduler (GitHub Actions, cron-job.org,
 * ...) that is configured with the shared secret. The secret is never placed in
 * a URL, logged, or echoed in a response.
 */
export const CRON_AUTHORIZATION_HEADER = "authorization";

/** Read the shared cron secret from the environment, treating blank as unset. */
export function resolveCronSecret(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = (env.CRON_SECRET ?? env.JOB_SCOUT_CRON_SECRET ?? "").trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Constant-time check that a request carries `Authorization: Bearer <secret>`.
 * Returns false whenever the secret is unset, the header is missing, or the
 * values differ, so the endpoint fails closed.
 */
export function verifyCronAuthorization(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length === 0) return false;
  if (authorization === undefined) return false;

  const provided = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
