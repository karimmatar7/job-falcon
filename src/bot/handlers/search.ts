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

function formatVacancy(v: Vacancy): string {
  const parts: string[] = [];
  parts.push(`*${escapeMd(v.title)}*`);
  parts.push(escapeMd(`Employer: ${v.employer}`));
  parts.push(escapeMd(`Location: ${v.location}`));
  if (v.salary) parts.push(escapeMd(`Salary: ${v.salary}`));
  parts.push(escapeMd(`Sponsorship: ${v.vacancySponsorshipStatus}`));
  if (v.sponsorshipEvidence) parts.push(escapeMd(`Evidence: ${v.sponsorshipEvidence}`));
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

/**
 * Build the MarkdownV2-safe reply for a search result, distinguishing:
 * confirmed vacancies, listings found but none confirmed, no listings found,
 * and sources unavailable.
 */
export function buildSearchReply(result: JobSearchResult): string {
  const { vacancies, stats, errors } = result;
  const sourceNote =
    errors.length > 0
      ? `\n\n${escapeMd(`Note: ${errors.length} source(s) were unavailable, so results may be incomplete.`)}`
      : '';

  if (vacancies.length > 0) {
    let body = escapeMd(`Found ${vacancies.length} confirmed sponsorship vacancy(ies). `);
    body += exclusionSummary(result);
    body += '\n\n';
    body += vacancies.map(formatVacancy).join('\n\n');

    if (body.length > MAX_MESSAGE_LENGTH) {
      body = body.slice(0, MAX_MESSAGE_LENGTH - 200);
      if (body.endsWith('\\')) body = body.slice(0, -1);
      body += escapeMd('\n\n... (truncated due to length)');
    }

    return body + sourceNote;
  }

  if (stats.fetched === 0 && errors.length > 0) {
    return escapeMd('Could not reach any job sources. Please try again later.');
  }

  if (stats.fetched === 0) {
    return escapeMd('No job listings were found by the configured sources.');
  }

  let message = escapeMd(
    `Found ${stats.fetched} listing(s), but none had explicit sponsorship evidence so nothing was returned.`,
  );
  message += `\n${exclusionSummary(result)}`;
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
