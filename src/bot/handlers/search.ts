import type { Context } from "grammy";
import type { Vacancy } from "../../models/vacancy.js";
import { RealJobSearchService } from "../../services/jobSearch.js";
import type { JobSearchResult, JobSearchStats } from "../../services/jobSearch.js";
import { deriveEvidenceState, evidenceStateLabel } from "../../services/sponsorship.js";
import type { EvidenceState } from "../../models/vacancy.js";
import { validateApplicationUrl } from "../../services/applicationUrl.js";
import { createDefaultSponsorRegister } from "../../services/sponsorRegister.js";
import type { Logger } from "../../utils/logger.js";
import { parseCommand } from "../command.js";
import { parseSearchArgs } from "../searchArgs.js";

const MAX_MESSAGE_LENGTH = 4000;

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~>#+\-=|{}.!`\\]/g, '\\$&');
}

type ResultGroup = "confirmed" | "alternative" | "not_offered";

function groupFor(vacancy: Vacancy): ResultGroup {
  if (vacancy.vacancySponsorshipStatus === "confirmed") return "confirmed";
  if (vacancy.vacancySponsorshipStatus === "not_offered") return "not_offered";
  return "alternative";
}

function sponsorshipLabel(vacancy: Vacancy, group: ResultGroup): string {
  if (group === "confirmed") return evidenceStateLabel("vacancy_sponsorship_confirmed");
  if (group === "alternative") return evidenceStateLabel(deriveEvidenceState(vacancy));
  return evidenceStateLabel("sponsorship_unavailable");
}

/**
 * The stored employer-register outcome, falling back to the legacy positive
 * flag for older vacancy data that predates `employerRegisterStatus`.
 */
function employerRegisterStatusOf(v: Vacancy): Vacancy["employerRegisterStatus"] {
  if (v.employerRegisterStatus !== undefined) return v.employerRegisterStatus;
  if (v.employerSponsorshipVerified === true) return "verified";
  return undefined;
}

/**
 * A concise employer-register line, kept separate from the vacancy-level
 * sponsorship status. It states the employer's licence capability only and never
 * implies the vacancy offers sponsorship (and `not_found` never means the
 * employer is unlicensed).
 */
function employerRegisterLine(v: Vacancy): string | null {
  switch (employerRegisterStatusOf(v)) {
    case "verified": {
      const entry = v.employerVerificationTarget ?? v.employer;
      const updated = v.sponsorRegisterUpdatedAt
        ? `, register updated ${v.sponsorRegisterUpdatedAt}`
        : "";
      return `Employer register: LICENSED SPONSOR - matched "${entry}" on the official register${updated}.`;
    }
    case "not_found":
      return "Employer register: no exact match on the official register - this does NOT prove the employer is unlicensed (legal/trading names can differ).";
    case "unavailable":
      return "Employer register: could not be checked (register unavailable) - no conclusion either way.";
    case "not_checked":
      return "Employer register: not checked - advertised by a recruitment agency and the hiring employer was not identified.";
    default:
      return null;
  }
}

function formatVacancy(v: Vacancy, group: ResultGroup): string {
  const parts: string[] = [];
  parts.push(`*${escapeMd(v.title)}*`);
  parts.push(escapeMd(`Employer: ${v.employer}`));
  parts.push(escapeMd(`Location: ${v.location}${v.locationEligibility ? ` (UK eligibility: ${v.locationEligibility})` : ''}`));
  if (v.salary) parts.push(escapeMd(`Salary: ${v.salary}`));
  parts.push(escapeMd(sponsorshipLabel(v, group)));
  const registerLine = employerRegisterLine(v);
  if (registerLine !== null) parts.push(escapeMd(registerLine));

  if (group === "confirmed" && v.sponsorshipEvidence) {
    parts.push(escapeMd(`Evidence: ${v.sponsorshipEvidence}`));
  } else if (group === "alternative") {
    if (v.fallbackReason) parts.push(escapeMd(`Why shown: ${v.fallbackReason}`));
    const note =
      v.employerSponsorshipVerified === true
        ? "Note: an authoritative UK register confirms this employer is licensed to sponsor, but the vacancy itself does not confirm sponsorship for this role."
        : v.employerSponsorLicence === "yes"
          ? "Note: the listing mentions a sponsor licence, but this does not confirm sponsorship for this specific role."
          : "Note: this listing contains no sponsorship evidence. Ask the employer whether they can sponsor this role.";
    parts.push(escapeMd(note));
  } else if (v.sponsorshipEvidence) {
    parts.push(escapeMd(`Evidence: ${v.sponsorshipEvidence}`));
  }

  if (v.matchScore !== undefined) parts.push(escapeMd(`Match: ${v.matchScore}/100`));
  const application = validateApplicationUrl(v.applicationUrl);
  if (application.status === 'direct' && application.url !== undefined) {
    parts.push(escapeMd(`Apply: ${application.url}`));
  } else {
    const note = v.applicationUrlNote ?? application.note ?? 'no direct listing URL was provided';
    parts.push(escapeMd(`Apply: link unavailable (${note})`));
  }
  if (v.source) parts.push(escapeMd(`Source: ${v.source}`));
  return parts.join('\n');
}

function sourceSummary(stats: JobSearchStats): string {
  const parts = stats.sources.map(s => {
    // Distinguish: not called (disabled), called but empty, and failed.
    if (s.status === 'failed') return `${s.name} FAILED`;
    if (s.status === 'disabled') return `${s.name} skipped`;
    if (s.fetched === 0) return `${s.name} 0 results`;
    return `${s.name} ${s.parsed}/${s.fetched}`;
  });
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function exclusionSummary(result: JobSearchResult): string {
  const { stats } = result;
  return escapeMd(
    `Coverage: sources [${sourceSummary(stats)}]; checked ${stats.fetched} listing(s). ` +
      `Excluded: closed=${stats.excludedClosed}, paid_training=${stats.excludedPaidTraining}, ` +
      `senior=${stats.excludedSenior}, ` +
      `location_ineligible=${stats.excludedIneligibleLocation}, ` +
      `not_offered=${stats.excludedNotOffered}, duplicates=${stats.excludedDuplicates}, ` +
      `tpp=${stats.excludedTpp}, invalid=${stats.excludedInvalid}, ` +
      `over_cap=${stats.excludedUnclear}, low_relevance=${stats.excludedLowRelevance}, ` +
      `confirmed_over_limit=${stats.excludedConfirmedOverLimit}.`,
  );
}

function sectionHeading(text: string): string {
  return `*${escapeMd(text)}*`;
}

/**
 * Build the MarkdownV2-safe reply for a search result, distinguishing:
 * confirmed vacancies, employer-verified and unconfirmed alternatives,
 * no listings found, and sources unavailable. Relevance scoring and
 * sponsorship verification are kept separate: alternatives are never counted
 * as confirmed.
 */
export function buildSearchReply(result: JobSearchResult): string {
  const { vacancies, stats, errors } = result;
  const confirmed = vacancies.filter(v => v.vacancySponsorshipStatus === "confirmed");
  const alternatives = vacancies.filter(v => v.vacancySponsorshipStatus === "unclear");

  const sourceNote =
    errors.length > 0
      ? `\n\n${escapeMd(`Note: ${errors.length} source(s) were unavailable, so results may be incomplete.`)}`
      : '';

  if (stats.fetched === 0 && errors.length > 0) {
    return escapeMd('Could not reach any job sources. Please try again later.');
  }

  if (stats.fetched === 0) {
    return escapeMd('No job listings were found by the configured sources.');
  }

  let message: string;
  if (confirmed.length > 0) {
    const altClause =
      alternatives.length > 0
        ? ` and ${alternatives.length} other relevant opportunity(ies) with unconfirmed sponsorship follow.`
        : '.';
    message = escapeMd(`Found ${confirmed.length} confirmed sponsorship vacancy(ies)${altClause}`);
  } else if (alternatives.length > 0) {
    message = escapeMd(
      `No vacancies with confirmed sponsorship were found. Showing ${alternatives.length} genuinely relevant alternative(s) where sponsorship is unconfirmed - ask the employer about sponsorship.`,
    );
  } else {
    message = escapeMd(
      `Found ${stats.fetched} listing(s), but none were usable: no confirmed or relevant alternative results open to UK-based candidates.`,
    );
  }

  message += `\n${exclusionSummary(result)}`;

  if (confirmed.length > 0) {
    message += `\n\n${sectionHeading('CONFIRMED SPONSORSHIP')}\n`;
    message += confirmed.map(v => formatVacancy(v, "confirmed")).join('\n\n');
  }

  if (alternatives.length > 0) {
    message += `\n\n${sectionHeading('OTHER RELEVANT OPPORTUNITIES (sponsorship unconfirmed)')}\n`;
    message += alternatives.map(v => formatVacancy(v, "alternative")).join('\n\n');
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH - 200);
    if (message.endsWith('\\')) message = message.slice(0, -1);
    message += escapeMd('\n\n... (truncated due to length)');
  }

  return message + sourceNote;
}

/** Treat a few common spellings as "on"; anything else (including unset) is off. */
function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalised = value.trim().toLowerCase();
  return normalised === '1' || normalised === 'true' || normalised === 'yes' || normalised === 'on';
}

export async function searchHandler(ctx: Context, logger?: Logger): Promise<void> {
  const parsed = parseCommand(ctx.message?.text);
  const args = parseSearchArgs(parsed?.args ?? []);

  if (!args.ok) {
    await ctx.reply(args.message);
    return;
  }

  const service = new RealJobSearchService(
    undefined,
    logger,
    createDefaultSponsorRegister(process.env, fetch, logger),
    { debugDecisions: isTruthyFlag(process.env.JOB_SCOUT_DEBUG_DECISIONS) },
  );
  try {
    const result = await service.search({
      limit: args.limit,
      keywords: args.keywords,
      ...(args.location === undefined ? {} : { location: args.location }),
    });
    await ctx.reply(buildSearchReply(result), { parse_mode: 'MarkdownV2' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`Search failed: ${msg}`);
  }
}
