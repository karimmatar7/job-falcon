/**
 * Application-link validation.
 *
 * A listing's "apply" link must point at the specific vacancy. Some feed
 * sources occasionally return a site homepage instead (or nothing at all), and
 * showing the homepage as if it were the job's application page is misleading.
 * This module decides whether a URL is a usable direct listing link and says
 * why not when it is not.
 *
 * It never rewrites a bad URL into a different one (for example, the source's
 * homepage): an unusable URL stays unusable and is reported as such.
 */

export type ApplicationUrlStatus = "direct" | "unavailable" | "invalid";

export interface ApplicationUrlValidation {
  /** `direct` when `url` is present, otherwise `unavailable` or `invalid`. */
  readonly status: ApplicationUrlStatus;
  /** Present only when `status === "direct"`. */
  readonly url?: string;
  /** Present only when no direct URL is usable. */
  readonly note?: string;
}

/**
 * Paths that are a site's own front page rather than a listing. Kept narrow on
 * purpose: a real listing path (e.g. `/jobs/details/123`) is never rejected.
 */
function isHomepage(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "");
  if (path.length === 0) return true;
  return /^\/(?:home|index\.(?:html?|php|aspx?|jsp))$/i.test(path);
}

export function validateApplicationUrl(
  raw: string | undefined | null,
): ApplicationUrlValidation {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return { status: "unavailable", note: "no direct listing URL was provided" };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { status: "invalid", note: "the listing URL is not a valid web address" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "invalid", note: "the listing URL is not an http(s) address" };
  }

  if (isHomepage(parsed)) {
    return {
      status: "unavailable",
      note: "the source provided its homepage, not a link to this listing",
    };
  }

  return { status: "direct", url: parsed.toString() };
}
