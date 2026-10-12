import type { Context } from "grammy";
import { RealJobSearchService } from "../../services/jobSearch.js";
import type { JobSearchResult, JobSearchStats } from "../../services/jobSearch.js";
import type { Vacancy } from "../../models/vacancy.js";
import { createDefaultSponsorRegister } from "../../services/sponsorRegister.js";
import type { Logger } from "../../utils/logger.js";
import type { BotServices } from "../services.js";
import { parseCommand } from "../command.js";
import { parseSearchArgs } from "../searchArgs.js";
import { escapeMd, formatVacancy } from "../vacancyCard.js";

const MAX_MESSAGE_LENGTH = 4000;

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

/** The vacancies a `/search` reply actually renders (confirmed + alternatives). */
export function searchReplyVacancies(result: JobSearchResult): Vacancy[] {
  return result.vacancies.filter(
    (vacancy) =>
      vacancy.vacancySponsorshipStatus === "confirmed" ||
      vacancy.vacancySponsorshipStatus === "unclear",
  );
}

export async function searchHandler(
  ctx: Context,
  logger?: Logger,
  services?: BotServices,
): Promise<void> {
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
    const sent = (await ctx.reply(buildSearchReply(result), {
      parse_mode: "MarkdownV2",
    })) as { message_id?: number } | undefined;

    // Index the vacancy message(s) so a following /save can resolve them.
    const chatId = ctx.chat?.id;
    const messageId = sent?.message_id;
    const shown = searchReplyVacancies(result);
    if (
      services !== undefined &&
      typeof chatId === "number" &&
      typeof messageId === "number" &&
      shown.length > 0
    ) {
      await services.savedVacancies
        .recordDelivered(chatId, messageId, shown)
        .catch(() => undefined);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`Search failed: ${msg}`);
  }
}
