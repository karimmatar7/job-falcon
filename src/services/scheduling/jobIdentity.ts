import type { Vacancy } from "../../models/vacancy.js";

/**
 * Stable identity keys for a vacancy, used to decide whether a listing has been
 * seen before. Three independent facets are derived so that the same vacancy
 * advertised on two sources (different ids and URLs) still collapses to one:
 *
 * - `url:` canonicalised application/source URL
 * - `id:`  the source-supplied listing id
 * - `et:`  normalised employer + title + location
 *
 * A listing is "new" only when none of its keys is already known. When it is
 * recorded, every key is stored, so either facet alone is enough to recognise
 * it again.
 */

function normaliseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|gh_src$|gh_jid$|source$|ref$|src$|mc_)/i;

/** Canonicalise a URL for comparison, dropping query tracking noise and `www.`. */
export function canonicalUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  const search = parsed.searchParams.toString();
  const path = pathname.length === 0 ? "/" : pathname;
  return `${parsed.protocol}//${parsed.hostname}${path}${search.length > 0 ? `?${search}` : ""}`;
}

/** Every identity key for a vacancy, primary key first. */
export function jobIdentityKeys(vacancy: Vacancy): string[] {
  const keys: string[] = [];
  keys.push(identityKey(vacancy));
  keys.push(`id:${vacancy.source}:${vacancy.id}`);
  keys.push(`id:${vacancy.id}`);
  const url = canonicalUrl(vacancy.applicationUrl ?? vacancy.sourceUrl);
  if (url !== undefined) keys.push(`url:${url}`);
  return [...new Set(keys)];
}

/** The primary (cross-source) identity key for a vacancy. */
export function identityKey(vacancy: Vacancy): string {
  return `et:${normaliseText(vacancy.employer)}||${normaliseText(
    vacancy.title,
  )}||${normaliseText(vacancy.location)}`;
}
