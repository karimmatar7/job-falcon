import type { SponsorshipStatus } from "../models/vacancy.js";

export interface SponsorshipEvidence {
  readonly status: SponsorshipStatus;
  readonly evidence: string;
  readonly employerLicenceStatus: "yes" | "no" | "unknown";
  readonly employerLicenceEvidence: string;
  readonly lastVerifiedAt: string;
}

export interface SponsorshipContext {
  readonly title: string;
  readonly employer: string;
  readonly description?: string;
  readonly sourceUrl: string;
}

const CONFIRMED_KEYWORDS = [
  "visa sponsorship",
  "sponsorship available",
  "will sponsor",
  "can sponsor",
  "we sponsor",
  "able to sponsor",
  "willing to sponsor",
  "happy to sponsor",
  "offer sponsorship",
  "provide sponsorship",
  "sponsoring visas",
  "skilled worker sponsorship",
  "visa sponsored",
  "sponsorship is available",
  "sponsorship provided",
];

const NEGATIVE_KEYWORDS = [
  "must have right to work in the uk",
  "must have the right to work in the uk",
  "you must have the right to work",
  "no sponsorship available",
  "sponsorship not available",
  "sponsorship is not available",
  "we are unable to sponsor",
  "unable to sponsor",
  "cannot sponsor",
  "not able to sponsor",
  "do not sponsor",
  "does not sponsor",
  "we do not sponsor",
  "visa sponsorship not available",
  "no visa sponsorship",
  "do not offer sponsorship",
  "does not offer sponsorship",
  "not offer sponsorship",
  "unable to offer sponsorship",
  "cannot offer sponsorship",
  "do not provide sponsorship",
  "not provide sponsorship",
  "do not provide visa assistance",
  "does not provide visa assistance",
  "not provide visa assistance",
  "no visa assistance",
  "cannot provide visa",
  "unable to provide visa",
  "not provide visa",
];

const LICENCE_KEYWORDS = [
  "uk sponsor licence",
  "uk visa sponsorship licence",
  "sponsor licence",
  "licensed sponsor",
  "holds a sponsor licence",
];

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKeyword(text: string, keyword: string): { index: number; length: number } | null {
  const match = new RegExp(escapeRegExp(keyword), "i").exec(text);
  if (match === null || match.index === undefined) return null;
  return { index: match.index, length: match[0].length };
}

/** Returns the full sentence containing a match, preserving original casing and wording. */
function extractWording(text: string, index: number, length: number): string {
  const before = text.slice(0, index);
  const boundaries = [". ", "! ", "? ", "\n"].reduce(
    (best, marker) => Math.max(best, before.lastIndexOf(marker)),
    -1,
  );
  const start = boundaries === -1 ? 0 : boundaries + 2;

  let end = text.length;
  for (const marker of [". ", "! ", "? ", "\n"]) {
    const found = text.indexOf(marker, index + length);
    if (found !== -1) end = Math.min(end, found + 1);
  }

  const sentence = text.slice(start, end).trim();
  return sentence.length > 300 ? `${sentence.slice(0, 297)}...` : sentence;
}

export function classifySponsorship(context: SponsorshipContext): SponsorshipEvidence {
  const textParts: string[] = [];
  if (context.title) textParts.push(context.title);
  if (context.employer) textParts.push(context.employer);
  if (context.description) textParts.push(context.description);
  const rawText = normalise(textParts.join(" \n "));

  const now = new Date().toISOString();

  let employerLicenceStatus: "yes" | "no" | "unknown" = "unknown";
  let employerLicenceEvidence = "No explicit licence information found in listing";

  for (const keyword of LICENCE_KEYWORDS) {
    if (findKeyword(rawText, keyword) !== null) {
      employerLicenceStatus = "yes";
      employerLicenceEvidence = `Employer mentions licence: "${keyword}" (from ${context.sourceUrl}, checked ${now})`;
      break;
    }
  }

  for (const keyword of NEGATIVE_KEYWORDS) {
    const match = findKeyword(rawText, keyword);
    if (match !== null) {
      const wording = extractWording(rawText, match.index, match.length);
      return {
        status: "not_offered",
        evidence: `Explicit statement indicates no sponsorship: "${wording}" (from ${context.sourceUrl})`,
        employerLicenceStatus,
        employerLicenceEvidence,
        lastVerifiedAt: now,
      };
    }
  }

  for (const keyword of CONFIRMED_KEYWORDS) {
    const match = findKeyword(rawText, keyword);
    if (match !== null) {
      const wording = extractWording(rawText, match.index, match.length);
      return {
        status: "confirmed",
        evidence: `Explicit statement supporting sponsorship: "${wording}" (from ${context.sourceUrl})`,
        employerLicenceStatus,
        employerLicenceEvidence,
        lastVerifiedAt: now,
      };
    }
  }

  return {
    status: "unclear",
    evidence: `No explicit sponsorship support found; silence about sponsorship (from ${context.sourceUrl})`,
    employerLicenceStatus,
    employerLicenceEvidence,
    lastVerifiedAt: now,
  };
}
