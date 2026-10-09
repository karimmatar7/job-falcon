import { z } from "zod";

/** Telegram command names: lowercase letters, digits and underscores. */
export const commandNameSchema = z
  .string()
  .regex(/^[a-z0-9_]{1,32}$/, "invalid command name");

export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * Parse a Telegram message into a command name and its arguments.
 *
 * Handles bot suffixes (e.g. `/help@JobScoutBot`), case-insensitivity and
 * collapsed whitespace. Returns `null` when the text is not a valid command.
 */
export function parseCommand(text: string | null | undefined): ParsedCommand | null {
  if (typeof text !== "string") return null;

  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const tokens = trimmed.slice(1).split(/\s+/);
  const rawCommand = tokens[0] ?? "";
  const [rawName = ""] = rawCommand.split("@");
  const name = rawName.toLowerCase();

  if (!commandNameSchema.safeParse(name).success) return null;

  return {
    name,
    args: tokens.slice(1).filter((token) => token.length > 0),
  };
}
