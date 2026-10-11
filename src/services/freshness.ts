import type { Vacancy } from "../models/vacancy.js";

/** Listings older than this are treated as stale and excluded. */
export const DEFAULT_MAX_AGE_DAYS = 45;

/** Explicit textual markers that a vacancy is closed / no longer accepting applications. */
export const EXPIRED_MARKERS = [
  "no longer accepting applications",
  "no longer accepting application",
  "no longer available",
  "position has been filled",
  "position filled",
  "role has been filled",
  "job has expired",
  "listing has expired",
  "applications are closed",
  "applications closed",
  "applications have closed",
  "vacancy has closed",
  "this vacancy is closed",
  "this position is closed",
  "we are no longer hiring for this role",
] as const;

export interface ExpiryAssessment {
  readonly expired: boolean;
  readonly reason?: string;
}

/**
 * Decide whether a listing is stale. A listing is only considered expired with
 * positive evidence: either an explicit closed marker in its own text, or a
 * publication date older than `maxAgeDays`. Missing/unparseable dates are never
 * treated as expired (absence of evidence).
 */
export function assessExpiry(
  vacancy: Pick<Vacancy, "title" | "description" | "datePosted">,
  now: Date = new Date(),
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): ExpiryAssessment {
  const text = `${vacancy.title} ${vacancy.description ?? ""}`.toLowerCase();
  const marker = EXPIRED_MARKERS.find((needle) => text.includes(needle));
  if (marker !== undefined) {
    return { expired: true, reason: `listing states "${marker}"` };
  }

  const posted = vacancy.datePosted;
  if (posted === undefined || posted.trim().length === 0) return { expired: false };

  const timestamp = Date.parse(posted);
  if (Number.isNaN(timestamp)) return { expired: false };

  const ageDays = (now.getTime() - timestamp) / (24 * 60 * 60 * 1000);
  if (ageDays > maxAgeDays) {
    return {
      expired: true,
      reason: `posted ${Math.round(ageDays)} days ago (limit ${maxAgeDays})`,
    };
  }
  return { expired: false };
}
