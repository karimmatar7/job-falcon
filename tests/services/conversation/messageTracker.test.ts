import { describe, expect, it } from "vitest";
import { MessageTracker } from "../../../src/services/conversation/messageTracker.js";
import { InMemoryStateStore, createInitialState } from "../../../src/services/state/stateStore.js";

const NOW = new Date("2026-06-01T09:00:00.000Z");

describe("MessageTracker", () => {
  it("records bot and user messages with timestamps", async () => {
    const store = new InMemoryStateStore();
    const tracker = new MessageTracker(store, { now: () => NOW });

    await tracker.recordBotMessage(42, 10);
    await tracker.recordUserMessage(42, 11);

    const messages = await tracker.getMessages(42);
    expect(messages).toEqual([
      { id: 10, at: NOW.toISOString(), direction: "bot" },
      { id: 11, at: NOW.toISOString(), direction: "user" },
    ]);
  });

  it("keeps chats separate", async () => {
    const store = new InMemoryStateStore();
    const tracker = new MessageTracker(store);
    await tracker.recordBotMessage(1, 100);

    expect(await tracker.getMessages(2)).toEqual([]);
    expect(await tracker.getMessages(1)).toHaveLength(1);
  });

  it("does not record the same message id twice", async () => {
    const store = new InMemoryStateStore();
    const tracker = new MessageTracker(store);
    await tracker.recordBotMessage(42, 7);
    await tracker.recordBotMessage(42, 7);

    expect(await tracker.getMessages(42)).toHaveLength(1);
  });

  it("bounds tracked messages per chat", async () => {
    const store = new InMemoryStateStore();
    const tracker = new MessageTracker(store, { maxPerChat: 3 });
    for (let id = 1; id <= 5; id++) {
      await tracker.recordBotMessage(42, id);
    }

    const messages = await tracker.getMessages(42);
    expect(messages.map((message) => message.id)).toEqual([3, 4, 5]);
  });

  it("returns a defensive copy", async () => {
    const store = new InMemoryStateStore();
    const tracker = new MessageTracker(store);
    await tracker.recordBotMessage(42, 1);

    const messages = await tracker.getMessages(42);
    messages.push({ id: 99, at: NOW.toISOString(), direction: "bot" });
    messages[0]!.direction = "user";

    const again = await tracker.getMessages(42);
    expect(again).toHaveLength(1);
    expect(again[0]?.direction).toBe("bot");
  });

  it("clearMessages removes only the requested chat", async () => {
    const store = new InMemoryStateStore();
    const tracker = new MessageTracker(store);
    await tracker.recordBotMessage(42, 1);
    await tracker.recordBotMessage(7, 2);

    await tracker.clearMessages(42);

    expect(await tracker.getMessages(42)).toEqual([]);
    expect(await tracker.getMessages(7)).toHaveLength(1);
  });

  it("clearMessages is a no-op for an empty chat", async () => {
    const store = new InMemoryStateStore(createInitialState());
    const tracker = new MessageTracker(store);
    await tracker.clearMessages(999);
    expect(await tracker.getMessages(999)).toEqual([]);
  });
});