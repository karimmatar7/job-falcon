import type { Context } from "grammy";
import type { Vacancy } from "../../models/vacancy.js";
import { RealJobSearchService } from "../../services/jobSearch.js";
import type { JobSearchResult } from "../../services/jobSearch.js";
import { parseCommand } from "../command.js";

const MAX_RESULTS = 10;
const MAX_MESSAGE_LENGTH = 4000;

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~>#+\-=|{}.!`\\]/g, '\\$&');
}

type ResultGroup = "confirmed" | "alternative" | "not_offered";

function sponsorshipLabel(v: Vacancy, group: ResultGroup): string {
  if (group === "confirmed") {
    return "Sponsorship: Confirmed";
  }
  if (group === "alternative") {
    return "Sponsorship: UNCONFIRMED \\- ask the employer";
  }
  return "Sponsorship: SPONSORSHIP NOT OFFERED";
}

function formatVacancy(v: Vacancy, group: ResultGroup): string {
  const parts: string[] = [];
  parts.push(`*${escapeMd(v.title)}*`);
  parts.push(escapeMd(`Employer: ${v.employer}`));
  parts.push(escapeMd(`Location: ${v.location}`));
  if (v.salary) parts.push(escapeMd(`Salary: ${v.salary}`));
  parts.push(sponsorshipLabel(v, group));

  if (group === "confirmed" && v.sponsorshipEvidence) {
    parts.push(escapeMd(`Evidence: ${v.sponsorshipEvidence}`));
  } else if (group === "alternative") {
    const note =
      v.employerSponsorLicence === "yes"
        ? "Note: the employer mentions a sponsor licence, but this listing does not confirm sponsorship for this specific role."
        : "Note: this listing contains no sponsorship evidence. Ask the employer whether they can sponsor this role.";
    parts.push(escapeMd(note));
  } else if (v.sponsorshipEvidence) {
    parts.push(escapeMd(`Evidence: ${v.sponsorshipEvidence}`));
  }

  if (v.matchExplanation) parts.push(escapeMd(`Match: ${v.matchExplanation}`));
  if (v.applicationUrl) parts.push(escapeMd(`Apply: ${v.applicationUrl}`));
  if (v.source) parts.push(escapeMd(`Source: ${v.source}`));
  return parts.join('\n');
}

function exclusionSummary(result: JobSearchResult): string {
  const { stats } = result;
  return escapeMd(
    `Checked ${stats.fetched} listing(s); excluded ` +
      `unclear=${stats.excludedUnclear}, not_offered=${stats.excludedNotOffered}, ` +
      `duplicates=${stats.excludedDuplicates}, tpp=${stats.excludedTpp}, closed=${stats.excludedClosed}.`,
  );
}

function sectionHeading(text: string): string {
  return `*${escapeMd(text)}*`;
}

/**
 * Build the MarkdownV2-safe reply for a search result, distinguishing:
 * confirmed vacancies, relevant alternatives with unconfirmed sponsorship,
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
      `No vacancies with confirmed sponsorship were found. Showing up to 2 other relevant opportunities where sponsorship is unconfirmed \\- ask the employer about sponsorship.`,
    );
  } else {
    message = escapeMd(
      `Found ${stats.fetched} listing(s), but none were usable confirmed or relevant alternative results.`,
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

export async function searchHandler(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  const parsed = parseCommand(text);
  let limit = 5;

  if (parsed && parsed.args.length > 0) {
    const arg = parsed.args[0];
    const parsedNum = parseInt(arg ?? '', 10);
    if (!isNaN(parsedNum) && parsedNum > 0) {
      limit = Math.min(parsedNum, MAX_RESULTS);
    } else {
      await ctx.reply('Invalid number. Usage: /search [number]');
      return;
    }
  }

  const service = new RealJobSearchService();
  try {
    const result = await service.search({ limit });
    await ctx.reply(buildSearchReply(result), { parse_mode: 'MarkdownV2' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`Search failed: ${msg}`);
  }
}
