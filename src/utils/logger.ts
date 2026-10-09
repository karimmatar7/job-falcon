const REDACTED = "[REDACTED]";

/** Convert an arbitrary value into a log-safe string. */
export function toLogString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Replace every occurrence of the provided secrets with `[REDACTED]`.
 * Secrets shorter than 4 characters are ignored to avoid corrupting normal text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

/**
 * Create a logger that can never print the given secrets (for example the
 * Telegram bot token), no matter what message or error payload it receives.
 */
export function createLogger(secrets: readonly string[] = []): Logger {
  const log = (level: LogLevel, message: string, details?: unknown): void => {
    const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
    const safeMessage = redactSecrets(message, secrets);
    const sink =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;

    if (details === undefined) {
      sink(`${prefix} ${safeMessage}`);
      return;
    }
    sink(`${prefix} ${safeMessage}`, redactSecrets(toLogString(details), secrets));
  };

  return {
    info: (message, details) => log("info", message, details),
    warn: (message, details) => log("warn", message, details),
    error: (message, details) => log("error", message, details),
  };
}
