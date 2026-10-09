import { z } from "zod";

const botTokenPattern = /^\d+:[A-Za-z0-9_-]+$/;
const userIdPattern = /^\d+$/;

/**
 * Zod schema describing every environment variable the bot needs.
 *
 * Note: validation messages never include the received value, so a malformed
 * Telegram bot token can never leak into logs or error output.
 */
export const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z
    .string({ message: "TELEGRAM_BOT_TOKEN is required" })
    .trim()
    .min(1, "TELEGRAM_BOT_TOKEN is required")
    .regex(botTokenPattern, "TELEGRAM_BOT_TOKEN has an invalid format"),
  TELEGRAM_ALLOWED_USER_ID: z
    .string({ message: "TELEGRAM_ALLOWED_USER_ID is required" })
    .trim()
    .min(1, "TELEGRAM_ALLOWED_USER_ID is required")
    .regex(userIdPattern, "TELEGRAM_ALLOWED_USER_ID must be a positive integer")
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value > 0, {
      message: "TELEGRAM_ALLOWED_USER_ID must be a positive safe integer",
    }),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly telegramBotToken: string;
  readonly allowedUserId: number;
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

  return {
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    allowedUserId: parsed.data.TELEGRAM_ALLOWED_USER_ID,
  };
}
