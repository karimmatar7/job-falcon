/**
 * Employer identity resolution.
 *
 * A listing's named organisation is not always the organisation doing the
 * hiring: recruitment agencies advertise on behalf of an unnamed client. This
 * module classifies the *advertiser* and, only when a listing explicitly names
 * the client, extracts the end employer.
 *
 * It is deliberately conservative:
 * - It never guesses an end employer from a fuzzy or ambiguous name.
 * - A verified register entry for the *advertiser* says nothing about the
 *   vacancy when the advertiser is an agency.
 * - Callers must treat a missing end employer as "unknown", not as the agency.
 */

import { normaliseOrganisation } from "./sponsorRegister.js";

export type AdvertiserRole = "employer" | "recruiter" | "unknown";

export interface EmployerIdentity {
  /** The name shown on the listing. */
  readonly advertiser: string;
  readonly advertiserRole: AdvertiserRole;
  /** The hiring organisation, only when the listing explicitly names it. */
  readonly endEmployer?: string;
}

/** Agency signals in the advertiser's own name. */
const RECRUITER_NAME_PATTERNS: readonly RegExp[] = [
  /\brecruit(?:er|ers|ing|ment)?\b/i,
  /\bstaffing\b/i,
  /\btalent\b/i,
  /\bresourc(?:e|es|ing)\b/i,
  /\bheadhunt(?:er|ers|ing)?\b/i,
  /\bsearch\s*(?:&|and)\s*selection\b/i,
  /\bemployment\s+agency\b/i,
  /\bpersonnel\b/i,
  /\bmanpower\b/i,
];

/** Agency signals in the listing text (usually "our client"). */
const RECRUITER_TEXT_PATTERNS: readonly RegExp[] = [
  /\bour\s+client\b/i,
  /\bon\s+behalf\s+of\s+(?:our|a|the)\s+client\b/i,
  /\bwe\s+are\s+recruiting\s+for\b/i,
  /\brecruiting\s+on\s+behalf\b/i,
  /\bclient\s*[:\-]/i,
  /\bworking\s+(?:for|with)\s+our\s+client\b/i,
];

/** Phrases that introduce a named client. */
const END_EMPLOYER_PHRASES: readonly RegExp[] = [
  /\bour\s+client(?:'s)?\b/i,
  /\bon\s+behalf\s+of(?:\s+our)?\s+client\b/i,
  /\bfor\s+our\s+client\b/i,
  /\bclient\s*[:\-]\s*/i,
  /\brecruiting\s+for\b/i,
  /\bworking\s+(?:for|with)\b/i,
];

const GENERIC_NAMES = new Set([
  "a",
  "an",
  "the",
  "our",
  "client",
  "company",
  "organisation",
  "organization",
  "business",
  "role",
  "position",
  "job",
  "candidate",
  "you",
  "we",
  "they",
  "this",
  "that",
  "uk",
  "global",
  "international",
  "leading",
  "growing",
  "successful",
  "established",
]);

/**
 * Capture a properly-capitalised organisation name immediately after a
 * phrase, allowing a short run of separators and stop-words in between.
 * Returns `undefined` when no plausible name follows (e.g. "our client, a
 * leading fintech" => undefined).
 */
function matchLeadingName(rest: string): string | undefined {
  const pattern =
    /^[\s,;:.\u2013\u2014-]*(?:is|are|was|were|named|called|a|an|the|for)?[\s,;:.\u2013\u2014-]*(?:a|an|the)?[\s,;:.\u2013\u2014-]*([A-Z][A-Za-z0-9&.'-]*(?:\s+(?:[A-Z0-9][A-Za-z0-9&.'-]*|of|and|&)){0,4})/;
  const match = pattern.exec(rest);
  const capture = match?.[1];
  return capture === undefined ? undefined : capture.replace(/[\s,;:.&'-]+$/, "").trim();
}

function isUsableName(name: string, advertiser: string): boolean {
  if (name.length < 2 || name.length > 60) return false;
  if (!/[A-Za-z]/.test(name)) return false;
  if (GENERIC_NAMES.has(name.toLowerCase())) return false;
  if (normaliseOrganisation(name) === normaliseOrganisation(advertiser)) return false;
  return true;
}

function extractEndEmployer(text: string, advertiser: string): string | undefined {
  for (const phrase of END_EMPLOYER_PHRASES) {
    const match = phrase.exec(text);
    if (match === null) continue;
    const rest = text.slice(match.index + match[0].length);
    const candidate = matchLeadingName(rest);
    if (candidate !== undefined && isUsableName(candidate, advertiser)) {
      return candidate;
    }
  }
  return undefined;
}

/** Classify whether the named advertiser is the employer or an agency. */
export function detectAdvertiserRole(employer: string, text: string): AdvertiserRole {
  const name = employer.trim();
  if (name.length === 0) return "unknown";
  if (RECRUITER_NAME_PATTERNS.some((pattern) => pattern.test(name))) return "recruiter";
  if (RECRUITER_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return "recruiter";
  return "employer";
}

export function resolveEmployerIdentity(input: {
  readonly employer: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}): EmployerIdentity {
  const advertiser = input.employer.trim();
  const text = [input.title ?? "", input.description ?? ""].join(" \n ");
  const advertiserRole = detectAdvertiserRole(advertiser, text);

  if (advertiserRole !== "recruiter") {
    return { advertiser, advertiserRole };
  }

  const endEmployer = extractEndEmployer(text, advertiser);
  return {
    advertiser,
    advertiserRole,
    ...(endEmployer === undefined ? {} : { endEmployer }),
  };
}

/**
 * The organisation whose register membership is meaningful for this vacancy.
 * For an agency with no named client this is `undefined` (unknown), so the
 * agency's own register entry is never mistaken for vacancy evidence.
 */
export function employerVerificationTarget(identity: EmployerIdentity): string | undefined {
  if (identity.advertiserRole === "recruiter") {
    return identity.endEmployer;
  }
  if (identity.advertiser.length === 0) return undefined;
  return identity.advertiser;
}
