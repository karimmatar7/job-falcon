import { MAX_TRACKED_MESSAGES } from "../state/stateStore.js";
import type { StateStore, TrackedMessage } from "../state/stateStore.js";

export interface MessageTrackerOptions {
  readonly maxPerChat?: number;
  readonly now?: () => Date;
}

/**
 * Records the Telegram message ids the bot exchanged with the authorised user,
 * so `/empty` can delete them later. Telegram's API cannot list a chat's
 * history, and a bot may only delete messages it knows the id of and that are
 * less than 48 hours old; tracking from now on is the only reliable approach.
 */
export class MessageTracker {
  private readonly store: StateStore;
  private readonly maxPerChat: number;
  private readonly now: () => Date;

  constructor(store: StateStore, options: MessageTrackerOptions = {}) {
    this.store = store;
    this.maxPerChat = options.maxPerChat ?? MAX_TRACKED_MESSAGES;
    this.now = options.now ?? (() => new Date());
  }

  recordBotMessage(chatId: number, messageId: number): Promise<void> {
    return this.record(chatId, messageId, "bot");
  }

  recordUserMessage(chatId: number, messageId: number): Promise<void> {
    return this.record(chatId, messageId, "user");
  }

  async getMessages(chatId: number): Promise<TrackedMessage[]> {
    const state = await this.store.get();
    return state.conversations.byChat[String(chatId)]?.messages ?? [];
  }

  async clearMessages(chatId: number): Promise<void> {
    await this.store.update((draft) => {
      delete draft.conversations.byChat[String(chatId)];
    });
  }

  private async record(
    chatId: number,
    messageId: number,
    direction: "bot" | "user",
  ): Promise<void> {
    const key = String(chatId);
    const at = this.now().toISOString();
    await this.store.update((draft) => {
      const conversation = draft.conversations.byChat[key] ?? { messages: [] };
      if (!conversation.messages.some((message) => message.id === messageId)) {
        conversation.messages.push({ id: messageId, at, direction });
      }
      if (conversation.messages.length > this.maxPerChat) {
        conversation.messages = conversation.messages.slice(-this.maxPerChat);
      }
      draft.conversations.byChat[key] = conversation;
    });
  }
}
