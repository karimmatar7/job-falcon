import { z } from "zod";

const botTokenPattern = /^\d+:[A-Za-z0-9_-]+$/;
const userIdPattern = /^\d+$/;
/** Telegram requires 1-256 characters from A-Z, a-z, 0-9, "_" and "-". */
const webhookSecretPattern = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Zod schema describing every environment variable the bot needs.
 *
 * The Telegram token may be provided either as `TELEGRAM_BOT_TOKEN` (local
 * development) or `BOT_TOKEN` (Vercel), so existing setups keep working.
 *
 * Note: validation messages never include the received value, so a malformed
 * Telegram bot token can never leak into logs or error output.
 */
export const envSchema = z
  .object({
    BOT_TOKEN: z
      .string()
      .trim()
      .min(1, "BOT_TOKEN must not be empty")
      .regex(botTokenPattern, "BOT_TOKEN has an invalid format")
      .optional(),
    TELEGRAM_BOT_TOKEN: z
      .string()
      .trim()
      .min(1, "TELEGRAM_BOT_TOKEN must not be empty")
      .regex(botTokenPattern, "TELEGRAM_BOT_TOKEN has an invalid format")
      .optional(),
    TELEGRAM_ALLOWED_USER_ID: z
      .string({ message: "TELEGRAM_ALLOWED_USER_ID is required" })
      .trim()
      .min(1, "TELEGRAM_ALLOWED_USER_ID is required")
      .regex(userIdPattern, "TELEGRAM_ALLOWED_USER_ID must be a positive integer")
      .transform((value) => Number(value))
      .refine((value) => Number.isSafeInteger(value) && value > 0, {
        message: "TELEGRAM_ALLOWED_USER_ID must be a positive safe integer",
      }),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .trim()
      .regex(
        webhookSecretPattern,
        "TELEGRAM_WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, _ and - (1-256 characters)",
      )
      .optional(),
    TELEGRAM_WEBHOOK_URL: z
      .string()
      .trim()
      .url("TELEGRAM_WEBHOOK_URL must be a valid URL")
      .optional(),
    ADZUNA_APP_ID: z
      .string()
      .trim()
      .min(
        1,
        "ADZUNA_APP_ID must not be empty (optional; both ADZUNA_APP_ID and ADZUNA_APP_KEY are required to enable Adzuna)",
      )
      .optional(),
    ADZUNA_APP_KEY: z
      .string()
      .trim()
      .min(
        1,
        "ADZUNA_APP_KEY must not be empty (optional; both ADZUNA_APP_ID and ADZUNA_APP_KEY are required to enable Adzuna)",
      )
      .optional(),
    ADZUNA_COUNTRY: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z]{2}$/,
        "ADZUNA_COUNTRY must be a 2-letter ISO country code such as gb",
      )
      .optional(),
    ADZUNA_MAX_PAGES: z
      .string()
      .trim()
      .regex(/^\d+$/, "ADZUNA_MAX_PAGES must be an integer between 1 and 10")
      .transform((value) => Number(value))
      .refine((value) => value >= 1 && value <= 10, {
        message: "ADZUNA_MAX_PAGES must be between 1 and 10",
      })
      .optional(),
    UK_SPONSOR_REGISTER_URL: z
      .string()
      .trim()
      .url("UK_SPONSOR_REGISTER_URL must be a valid URL")
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.BOT_TOKEN && !data.TELEGRAM_BOT_TOKEN) {
      ctx.addIssue({
        code: "custom",
        message: "TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is required",
        path: ["TELEGRAM_BOT_TOKEN"],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly telegramBotToken: string;
  readonly allowedUserId: number;
  /** Secret compared against `X-Telegram-Bot-Api-Secret-Token` in webhook mode. */
  readonly webhookSecret?: string;
  /** Public base URL of the deployment (used only by the setup script). */
  readonly webhookUrl?: string;
  /** Adzuna UK source app id; the source activates only with a matching key. */
  readonly adzunaAppId?: string;
  /** Adzuna UK source app key; the source activates only with a matching id. */
  readonly adzunaAppKey?: string;
  /** Adzuna ISO 2-letter country code for sources (defaults to `gb`). */
  readonly adzunaCountry?: string;
  /** Adzuna result pages walked per search (1-10, defaults to 2). */
  readonly adzunaMaxPages?: number;
  /** Optional URL to the UK sponsor register CSV or gov.uk publication page. */
  readonly sponsorRegisterUrl?: string;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Validate the provided environment (defaults to `process.env`) and return a
 * typed, immutable configuration object. Throws {@link ConfigError} with a
 * value-free description when anything is missing or malformed.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const {
    BOT_TOKEN,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_ALLOWED_USER_ID,
    TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_WEBHOOK_URL,
    ADZUNA_APP_ID,
    ADZUNA_APP_KEY,
    ADZUNA_COUNTRY,
    ADZUNA_MAX_PAGES,
    UK_SPONSOR_REGISTER_URL,
  } = parsed.data;

  const telegramBotToken = TELEGRAM_BOT_TOKEN ?? BOT_TOKEN;
  if (telegramBotToken === undefined) {
    throw new ConfigError([
      "TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is required",
    ]);
  }

  return {
    telegramBotToken,
    allowedUserId: TELEGRAM_ALLOWED_USER_ID,
    ...(TELEGRAM_WEBHOOK_SECRET === undefined
      ? {}
      : { webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
    ...(TELEGRAM_WEBHOOK_URL === undefined
      ? {}
      : { webhookUrl: TELEGRAM_WEBHOOK_URL }),
    ...(ADZUNA_APP_ID === undefined ? {} : { adzunaAppId: ADZUNA_APP_ID }),
    ...(ADZUNA_APP_KEY === undefined ? {} : { adzunaAppKey: ADZUNA_APP_KEY }),
    ...(ADZUNA_COUNTRY === undefined ? {} : { adzunaCountry: ADZUNA_COUNTRY }),
    ...(ADZUNA_MAX_PAGES === undefined ? {} : { adzunaMaxPages: ADZUNA_MAX_PAGES }),
    ...(UK_SPONSOR_REGISTER_URL === undefined
      ? {}
      : { sponsorRegisterUrl: UK_SPONSOR_REGISTER_URL }),
  };
}
