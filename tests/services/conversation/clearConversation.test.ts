import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_DELETE_WINDOW_MS,
  clearConversation,
  isAgeRelatedDeleteError,
} from "../../../src/services/conversation/clearConversation.js";
import type { TrackedMessage } from "../../../src/services/state/stateStore.js";
import { silentLogger } from "../../testKit.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function message(id: number, at: string): TrackedMessage {
  return { id, at, direction: "bot" };
}

describe("clearConversation", () => {
  it("deletes recent messages and reports the outcome", async () => {
    const deleteMessage = vi.fn(async () => undefined);
    const result = await clearConversation({
      chatId: 42,
      messages: [
        message(10, NOW.toISOString()),
        message(11, NOW.toISOString()),
      ],
      deleteMessage,
      now: () => NOW,
    });

    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(deleteMessage).toHaveBeenCalledWith(42, 10);
    expect(deleteMessage).toHaveBeenCalledWith(42, 11);
    expect(result).toEqual({
      attempted: 2,
      deleted: 2,
      failed: 0,
      skippedOld: 0,
      failures: [],
    });
  });

  it("skips messages older than Telegram's 48-hour window", async () => {
    const deleteMessage = vi.fn(async () => undefined);
    const cutoff = new Date(NOW.getTime() - TELEGRAM_DELETE_WINDOW_MS).toISOString();
    const result = await clearConversation({
      chatId: 42,
      messages: [
        message(1, "2020-01-01T00:00:00.000Z"),
        message(2, cutoff),
        message(3, NOW.toISOString()),
      ],
      deleteMessage,
      now: () => NOW,
    });

    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(deleteMessage).not.toHaveBeenCalledWith(42, 1);
    expect(result).toEqual({
      attempted: 2,
      deleted: 2,
      failed: 0,
      skippedOld: 1,
      failures: [],
    });
  });

  it("reports delete failures without pretending they were removed", async () => {
    const deleteMessage = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("telegram: 400 message is too old"))
      .mockResolvedValueOnce(undefined);
    const failures: { messageId: number; reason: string }[] = [];
    const result = await clearConversation({
      chatId: 42,
      messages: [message(1, NOW.toISOString()), message(2, NOW.toISOString())],
      deleteMessage,
      now: () => NOW,
      onDelete: async (deleted) => {
        failures.push({ messageId: deleted.id, reason: "tracked" });
      },
    });

    expect(result).toEqual({
      attempted: 2,
      deleted: 1,
      failed: 1,
      skippedOld: 0,
      failures: [{ messageId: 1, reason: "telegram: 400 message is too old" }],
    });
    expect(failures.map((entry) => entry.messageId)).toEqual([2]);
  });

  it("calls onDelete for each successfully deleted message", async () => {
    const deleted: number[] = [];
    await clearConversation({
      chatId: 42,
      messages: [message(5, NOW.toISOString()), message(6, NOW.toISOString())],
      deleteMessage: vi.fn(async () => undefined),
      now: () => NOW,
      onDelete: async (tracked) => {
        deleted.push(tracked.id);
      },
    });
    expect(deleted).toEqual([5, 6]);
  });

  it("survives an onDelete failure and still counts the deletion", async () => {
    const logger = {
      ...silentLogger,
      warn: vi.fn(),
    };
    const result = await clearConversation({
      chatId: 42,
      messages: [message(5, NOW.toISOString())],
      deleteMessage: vi.fn(async () => undefined),
      now: () => NOW,
      onDelete: async () => {
        throw new Error("history update failed");
      },
      logger,
    });

    expect(result).toEqual({ attempted: 1, deleted: 1, failed: 0, skippedOld: 0, failures: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      "Deleted a message but could not update the message history",
      expect.anything(),
    );
  });

  it("honours a caller-provided retention window", async () => {
    const deleteMessage = vi.fn(async () => undefined);
    const result = await clearConversation({
      chatId: 42,
      messages: [message(1, "2026-05-31T00:00:00.000Z")],
      deleteMessage,
      now: () => NOW,
      retentionMs: 60 * 60 * 1000, // only the last hour is eligible
    });
    expect(result.skippedOld).toBe(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});

describe("isAgeRelatedDeleteError", () => {
  it("recognises age-related Telegram descriptions", () => {
    expect(isAgeRelatedDeleteError("message is too old")).toBe(true);
    expect(isAgeRelatedDeleteError("message can't be deleted")).toBe(true);
    expect(isAgeRelatedDeleteError("can't be deleted")).toBe(true);
    expect(isAgeRelatedDeleteError("cannot be deleted")).toBe(true);
    expect(isAgeRelatedDeleteError("message to delete not found")).toBe(true);
  });

  it("treats unrelated errors as non-age-related", () => {
    expect(isAgeRelatedDeleteError("telegram: 500")).toBe(false);
    expect(isAgeRelatedDeleteError("chat not found")).toBe(false);
    expect(isAgeRelatedDeleteError("bot was blocked")).toBe(false);
  });
});