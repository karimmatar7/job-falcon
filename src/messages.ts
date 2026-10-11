export const BOT_NAME = "Job Scout";
export const PHASE = 2;

export const UNAUTHORIZED_MESSAGE =
  "This is a private bot. You are not authorised to use it.";

export const START_MESSAGE = [
  `Hello! I am ${BOT_NAME}, your private UK job-hunting assistant.`,
  "",
  "I search for real UK job vacancies, showing confirmed sponsorship results first.",
  "When no role has confirmed sponsorship, I still show relevant alternatives and flag them as UNCONFIRMED so you can ask the employer.",
  "",
  "Type /help to see what I can do.",
].join("\n");

export const HELP_MESSAGE = [
  `${BOT_NAME} - available commands`,
  "",
  "/start  - show a short introduction",
  "/help   - show this command list",
  "/status - show the bot status",
  "/search - search for confirmed sponsorship plus up to 5 relevant unconfirmed alternatives",
  "        /search [limit] [keywords] [location]",
  "        e.g. /search 5 software developer leeds  (limit 1-10, default 5)",
  "        e.g. /search javascript leeds",
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

export function buildStatusMessage(params: {
  readonly allowedUserId: number;
  readonly phase: number;
}): string {
  return [
    `${BOT_NAME} status`,
    "",
    "State: online",
    `Phase: ${params.phase}`,
    `Authorised Telegram user ID: ${params.allowedUserId}`,
    "",
    "Enabled: /start, /help, /status, /search",
    "Features: real job search, sponsorship verification, confirmed + unconfirmed alternative results, deduplication, relevance scoring",
  ].join("\n");
}
