import { parseCommand } from "./command.js";
import { buildUnknownCommandMessage } from "../messages.js";

/**
 * Decide how the bot should reply to a plain text message.
 *
 * Returns the reply text for an unrecognised slash command, or `null` for
 * normal chatter (which the bot ignores silently).
 */
export function replyForText(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;

  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const parsed = parseCommand(trimmed);
  if (parsed === null) return null;

  return buildUnknownCommandMessage(parsed.name);
}
