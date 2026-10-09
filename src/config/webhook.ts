/**
 * Resolve the public base URL of the deployment for webhook registration.
 *
 * Precedence: an explicit `TELEGRAM_WEBHOOK_URL` (or `PUBLIC_URL`), otherwise
 * Vercel's automatically provided `VERCEL_URL` (which has no scheme).
 */
export function resolveWebhookBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = (env.TELEGRAM_WEBHOOK_URL ?? env.PUBLIC_URL ?? "").trim();
  if (explicit.length > 0) {
    return explicit;
  }

  const vercel = (env.VERCEL_URL ?? "").trim();
  if (vercel.length > 0) {
    return `https://${vercel.replace(/^https?:\/\//, "")}`;
  }

  return "";
}

/** Build the full Telegram webhook URL for a deployment base URL. */
export function buildWebhookUrl(baseUrl: string): string {
  return new URL("/api/webhook", baseUrl).toString();
}
