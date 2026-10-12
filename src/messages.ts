import type { RunRecord, ScheduleSettings, SavedVacancy } from "./services/state/stateStore.js";
import type { Vacancy } from "./models/vacancy.js";
import { formatRelative, formatWallClock } from "./services/scheduling/scheduleTime.js";

export const BOT_NAME = "Job Scout";
export const PHASE = 3;

export const UNAUTHORIZED_MESSAGE =
  "This is a private bot. You are not authorised to use it.";

export const START_MESSAGE = [
  `Hello! I am ${BOT_NAME}, your private UK job-hunting assistant.`,
  "",
  "I search for real UK job vacancies, showing confirmed sponsorship results first.",
  "When no role has confirmed sponsorship, I still show relevant alternatives and flag them as UNCONFIRMED so you can ask the employer.",
  "",
  "I can also run automatic daily searches and alert you about newly discovered jobs.",
  "",
  "Type /help to see what I can do.",
].join("\n");

export const HELP_MESSAGE = [
  `${BOT_NAME} - available commands`,
  "",
  "/start   - show a short introduction",
  "/help    - show this command list",
  "/status  - show the bot, schedule and alert status",
  "/search  - search now for confirmed sponsorship plus up to 5 relevant unconfirmed alternatives",
  "        /search [limit] [keywords] [location]",
  "        e.g. /search 5 software developer leeds  (limit 1-10, default 5)",
  "        e.g. /search javascript leeds",
  "/schedule - show the daily search schedule and its options",
  "        /schedule on|off",
  "        /schedule time HH:MM            (24-hour, e.g. 08:00)",
  "        /schedule timezone Europe/London",
  "/pause   - temporarily pause automatic alerts (searches may still run)",
  "/resume  - resume automatic alerts",
  "/save    - save the vacancy from the message you just received (kept through /empty)",
  "        reply /save to a specific vacancy message, or /save <number> to pick one",
  "/saved   - list the vacancies you have saved",
  "/empty   - clear this chat of messages the bot is allowed to delete (saved vacancies are kept)",
  "",
  "Only the authorised Telegram user can use these commands.",
].join("\n");

export const SEARCH_PLACEHOLDER_MESSAGE = "Job search is available in Phase 2.";

export function buildUnknownCommandMessage(commandName: string): string {
  return [
    `I do not recognise the command "/${commandName}".`,
    "",
    "Type /help to see the available commands.",
  ].join("\n");
}

export const SCHEDULE_HELP = [
  "Schedule options:",
  "/schedule           - show the current schedule",
  "/schedule on        - enable automatic daily searches",
  "/schedule off       - disable automatic searches (settings are kept)",
  "/schedule time HH:MM - set the daily search time (24-hour, e.g. 08:00)",
  "/schedule timezone <IANA> - set the timezone, e.g. Europe/London",
  "",
  "Notifications are controlled separately with /pause and /resume.",
].join("\n");

export function buildScheduleSettingsMessage(
  settings: ScheduleSettings,
  nextRunAt: string | undefined,
  now: Date,
): string {
  const lines = [
    "Current schedule",
    "",
    `Status: ${settings.enabled ? "ENABLED" : "DISABLED"}`,
    `Alerts: ${settings.alertsPaused ? "PAUSED" : "active"}`,
    `Daily time: ${settings.time} (${settings.timeZone})`,
    `Query: keywords ${settings.keywords.join(" ") || "(default)"}, limit ${settings.limit}` +
      (settings.location === undefined ? "" : `, location ${settings.location}`),
  ];
  if (settings.enabled) {
    if (nextRunAt !== undefined) {
      const target = new Date(nextRunAt);
      if (!Number.isNaN(target.getTime())) {
        lines.push(
          `Next run: ${formatWallClock(target, settings.timeZone)} (${settings.timeZone}) ${formatRelative(target, now)}`,
        );
      }
    }
  } else {
    lines.push("Next run: none - automatic searches are disabled.");
  }
  return [...lines, "", SCHEDULE_HELP].join("\n");
}

export function buildScheduleTurnedOnMessage(
  settings: ScheduleSettings,
  nextRunAt: string | undefined,
  now: Date,
): string {
  const lines = [
    "Automatic searches are now ENABLED.",
    `Daily time: ${settings.time} (${settings.timeZone}).`,
  ];
  if (nextRunAt !== undefined) {
    const target = new Date(nextRunAt);
    if (!Number.isNaN(target.getTime())) {
      lines.push(
        `Next run: ${formatWallClock(target, settings.timeZone)} (${settings.timeZone}) ${formatRelative(target, now)}.`,
      );
    }
  }
  lines.push("Use /schedule off to disable, or /pause to silence alerts only.");
  return lines.join("\n");
}

export const SCHEDULE_TURNED_OFF_MESSAGE = [
  "Automatic searches are now DISABLED.",
  "Your settings, notification history and saved jobs are kept - /schedule on restarts exactly where you left off.",
  "Manual /search still works normally.",
].join("\n");

export const SCHEDULE_ON_USAGE = [
  'Usage: /schedule on',
  '       /schedule off',
  '       /schedule time HH:MM',
  '       /schedule timezone <IANA timezone>',
  'Run /schedule with no arguments to see the current settings.',
].join("\n");

export const ALERTS_PAUSED_MESSAGE = [
  "Automatic alerts are now PAUSED.",
  "Scheduled searches may still run and update the history, but no new-job alerts will be sent.",
  "Run /resume to start alerts again.",
].join("\n");

export const ALERTS_RESUMED_MESSAGE = [
  "Automatic alerts are now active again.",
  "Any notifications that were waiting will be sent now.",
].join("\n");

export function buildStatusMessage(params: {
  readonly allowedUserId: number;
  readonly phase: number;
  readonly scheduling?: {
    readonly settings: ScheduleSettings;
    readonly nextRunAt?: string;
    readonly lastRun?: RunRecord;
    readonly recentRuns: readonly RunRecord[];
    readonly pendingNotifications: number;
  };
  readonly now?: () => Date;
}): string {
  const now = params.now ?? (() => new Date());
  const lines = [
    `${BOT_NAME} status`,
    "",
    "State: online",
    `Phase: ${params.phase}`,
    `Authorised Telegram user ID: ${params.allowedUserId}`,
  ];

  const scheduling = params.scheduling;
  if (scheduling === undefined) {
    lines.push("", "Scheduling: unavailable (services not configured)");
  } else {
    const { settings, nextRunAt, lastRun, recentRuns, pendingNotifications } = scheduling;
    lines.push("");
    lines.push(`Scheduling: ${settings.enabled ? "ENABLED" : "DISABLED"}`);
    lines.push(`Alerts: ${settings.alertsPaused ? "PAUSED" : "active"}`);
    lines.push(`Daily search time: ${settings.time} (${settings.timeZone})`);

    if (settings.enabled && nextRunAt !== undefined) {
      const target = new Date(nextRunAt);
      if (!Number.isNaN(target.getTime())) {
        lines.push(
          `Next run: ${formatWallClock(target, settings.timeZone)} (${settings.timeZone}) ${formatRelative(target, now())}`,
        );
      }
    } else if (!settings.enabled) {
      lines.push("Next run: none - automatic searches are disabled");
    }

    if (lastRun !== undefined) {
      lines.push(
        `Last run: ${formatWallClock(new Date(lastRun.startedAt), settings.timeZone)} - ${lastRun.status}` +
          (lastRun.error === undefined ? "" : ` (${lastRun.error})`) +
          ` discovered ${lastRun.discovered}, notified ${lastRun.notified}, failed ${lastRun.failed}`,
      );
    } else {
      lines.push("Last run: never");
    }

    const recent = recentRuns.slice(-5);
    if (recent.length > 0) {
      lines.push("Recent runs (latest last):");
      for (const run of recent) {
        lines.push(
          `- ${formatWallClock(new Date(run.startedAt), settings.timeZone)} ${run.status} (discovered ${run.discovered}, notified ${run.notified}, failed ${run.failed})`,
        );
      }
    }

    lines.push(`Pending notifications: ${pendingNotifications}`);
  }

  lines.push(
    "",
    "Enabled: /start, /help, /status, /search, /schedule, /pause, /resume, /save, /saved, /empty",
    "Features: real job search, sponsorship verification, confirmed + unconfirmed alternative results, deduplication, relevance scoring, scheduled daily searches, new-job alerts, saved vacancies, chat cleanup",
  );
  return lines.join("\n");
}

export function buildScheduleInvalidTimeMessage(value: string): string {
  return [
    `"${value}" is not a valid time. Use 24-hour HH:MM, for example 08:00 or 17:30.`,
    "",
    "Usage: /schedule time HH:MM",
  ].join("\n");
}

export function buildScheduleInvalidTimeZoneMessage(value: string): string {
  return [
    `"${value}" is not a recognised IANA timezone (for example Europe/London or Europe/Paris).`,
    "",
    "Usage: /schedule timezone <IANA timezone>",
  ].join("\n");
}

/**
 * Explains that `/empty` found nothing it can delete. `preservedMessages` and
 * `preservedRecords` are the saved-vacancy protections, which are still worth
 * mentioning even when there is no disposable history.
 */
export function buildEmptyNoHistoryMessage(
  preservedMessages: number,
  preservedRecords: number,
): string {
  const lines = [
    "There is nothing for me to clear yet.",
    "Telegram does not let a bot list a chat's history, so I can only delete messages I have seen since this version started tracking.",
  ];
  if (preservedRecords > 0) {
    lines.push(
      `Your ${preservedRecords} saved vacancy(ies) and their messages are kept - view them with /saved.`,
    );
  }
  lines.push(
    "For older messages, use Telegram's own \"Clear history\" in the chat menu - it removes both sides.",
  );
  return lines.join("\n");
}

export const EMPTY_NO_HISTORY_MESSAGE = buildEmptyNoHistoryMessage(0, 0);

/**
 * Confirmation for `/save`. The saved record and the original Telegram message
 * survive `/empty`, so the wording says so explicitly.
 */
export function buildSaveConfirmationMessage(entry: SavedVacancy): string {
  return [
    `Saved vacancy #${entry.id}: ${entry.vacancy.title} at ${entry.vacancy.employer}.`,
    "It will be kept when you run /empty. Use /saved to see everything you've saved.",
  ].join("\n");
}

export function buildAlreadySavedMessage(entry: SavedVacancy): string {
  return [
    `You already saved this vacancy (#${entry.id}: ${entry.vacancy.title} at ${entry.vacancy.employer}).`,
    "Use /saved to view your saved vacancies.",
  ].join("\n");
}

export const SAVE_NO_RECENT_MESSAGE = [
  "I do not have a recent vacancy message to save.",
  "Run /search or wait for a job alert, then send /save straight after the vacancy message.",
  "You can also reply /save to a specific vacancy message.",
].join("\n");

export const SAVE_USAGE_MESSAGE = [
  "Usage: /save            save the vacancy from the most recent vacancy message",
  "       /save <number>   pick one when a message contained several vacancies",
  "       (reply /save to a specific vacancy message to save from it)",
].join("\n");

/** A single message carried several vacancies; ask which one to save. */
export function buildSaveSelectionMessage(vacancies: readonly Vacancy[]): string {
  const lines = [
    "That message contains several vacancies. Reply with the number you want to save:",
    "",
  ];
  vacancies.slice(0, 10).forEach((vacancy, index) => {
    lines.push(`${index + 1}. ${vacancy.title} - ${vacancy.employer} (${vacancy.location})`);
  });
  if (vacancies.length > 10) lines.push(`... and ${vacancies.length - 10} more.`);
  lines.push("", "Usage: /save <number>  (for example /save 2)");
  return lines.join("\n");
}

export function buildSaveInvalidSelectionMessage(count: number): string {
  return `Please choose a number between 1 and ${count}. Usage: /save <number>`;
}

export function buildSavedListMessage(entries: readonly SavedVacancy[]): string {
  const lines = [`Saved vacancies (${entries.length}):`, ""];
  entries.slice(0, 20).forEach((entry) => {
    lines.push(
      `#${entry.id}  ${entry.vacancy.title} - ${entry.vacancy.employer} (${entry.vacancy.location})`,
    );
    if (entry.vacancy.applicationUrl !== undefined) {
      lines.push(`     Apply: ${entry.vacancy.applicationUrl}`);
    }
  });
  if (entries.length > 20) lines.push(`... and ${entries.length - 20} more.`);
  lines.push("", "These are kept through /empty.");
  return lines.join("\n");
}

export const SAVED_EMPTY_MESSAGE = [
  "You have no saved vacancies yet.",
  "When a vacancy arrives, send /save to keep it (and its message) through /empty.",
].join("\n");

export function buildEmptySummary(params: {
  readonly deleted: number;
  readonly failed: number;
  readonly failedAgeRelated: number;
  readonly skippedOld: number;
  readonly preservedMessages: number;
  readonly preservedRecords: number;
}): string {
  const {
    deleted,
    failed,
    failedAgeRelated,
    skippedOld,
    preservedMessages,
    preservedRecords,
  } = params;
  const undeleted = failed + skippedOld;

  const lines = [
    "Chat cleanup finished.",
    "",
    `Messages deleted: ${deleted}`,
    `Saved vacancy messages preserved: ${preservedMessages}`,
    `Messages that could not be deleted: ${undeleted}`,
  ];

  const details: string[] = [];
  if (skippedOld > 0) {
    details.push(
      `${skippedOld} older than Telegram's 48-hour deletion window and were left in place.`,
    );
  }
  const nonAgeRelated = failed - failedAgeRelated;
  if (nonAgeRelated > 0) {
    details.push(`${nonAgeRelated} could not be deleted (Telegram error).`);
  }
  if (failedAgeRelated > 0) {
    details.push(`${failedAgeRelated} were rejected by Telegram as too old or already gone.`);
  }

  if (undeleted > 0 || details.length > 0) {
    lines.push("");
    lines.push(
      "Reason: Telegram only lets a bot delete messages it knows the id of, and only within 48 hours of sending.",
    );
    if (details.length > 0) lines.push(...details);
  }

  if (preservedRecords > 0) {
    lines.push("");
    lines.push(
      `Your ${preservedRecords} saved vacancy(ies), and the message(s) they came from, were kept - view them with /saved.`,
    );
  }

  lines.push("");
  lines.push(
    "Messages the bot never saw, and anything older than 48 hours, cannot be deleted by a bot.",
  );
  lines.push(
    "Practical fallback: use Telegram's own \"Clear history\" (chat menu) to remove the rest on both sides.",
  );
  lines.push("Your schedule settings, seen-job history and notification queue are untouched.");
  lines.push("The bot is ready - /help lists the commands.");
  return lines.join("\n");
}

/**
 * Sent after a scheduled search completes successfully and finds nothing new to
 * alert about. Only ever sent for scheduled runs, never for manual `/search`,
 * and never when alerts are paused or a job alert went out in the same run.
 */
export const SCHEDULED_SEARCH_COMPLETE_MESSAGE = [
  "\u{1F50E} JobFalcon Daily Search Complete",
  "No new relevant vacancies found today.",
  "I'll keep looking and notify you when new opportunities appear.",
].join("\n");

/**
 * Sent when a scheduled search finished but one or more job sources failed, so
 * the result is inconclusive rather than empty.
 */
export function buildScheduledSearchIncompleteMessage(sourceCount: number): string {
  return [
    "\u26A0\uFE0F JobFalcon Daily Search Incomplete",
    `Today's scheduled search could not be completed: ${sourceCount} job source(s) failed.`,
    "Because the sources failed, I can't say whether new vacancies appeared - I won't report this as an empty result.",
    "I'll try again at the next scheduled search.",
  ].join("\n");
}

/**
 * Sent when a scheduled search threw outright (e.g. a network/pipeline error),
 * so no truthful "no new vacancies" claim can be made.
 */
export const SCHEDULED_SEARCH_FAILED_MESSAGE = [
  "\u26A0\uFE0F JobFalcon Daily Search Failed",
  "Today's scheduled search could not be completed, so I can't say whether new vacancies appeared.",
  "I'll try again at the next scheduled search.",
].join("\n");