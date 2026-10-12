import type { Vacancy } from "../models/vacancy.js";
import type { SavedVacancy, StateStore } from "./state/stateStore.js";
import {
  MAX_SAVED_VACANCIES,
  MAX_VACANCY_REFS,
} from "./state/stateStore.js";
import { identityKey, jobIdentityKeys } from "./scheduling/jobIdentity.js";

export interface SavedVacancyServiceOptions {
  readonly store: StateStore;
  readonly now?: () => Date;
  readonly maxSaved?: number;
  readonly maxRefs?: number;
}

/** One recently delivered message that carried vacancies, grouped by message. */
export interface RecentVacancyGroup {
  readonly messageId: number;
  readonly at: string;
  readonly vacancies: readonly Vacancy[];
}

export type SaveOutcome =
  | { readonly status: "saved"; readonly entry: SavedVacancy }
  | { readonly status: "already_saved"; readonly entry: SavedVacancy }
  | { readonly status: "no_recent_vacancy" }
  | {
      readonly status: "selection_required";
      readonly messageId: number;
      readonly vacancies: readonly Vacancy[];
    }
  | {
      readonly status: "invalid_selection";
      readonly messageId: number;
      readonly count: number;
    };

/**
 * Owns explicit saved vacancies (`/save`) and the small index that maps recently
 * delivered Telegram messages back to the vacancies they carried.
 *
 * The saved records deliberately live in their own part of the state document,
 * outside `conversations`, so `/empty` can wipe chat history without ever losing
 * a saved vacancy or the message it came from. The index is only used to resolve
 * "the vacancy I just received"; it is pruned after cleanup so it can never
 * point at a message that no longer exists.
 */
export class SavedVacancyService {
  private readonly store: StateStore;
  private readonly now: () => Date;
  private readonly maxSaved: number;
  private readonly maxRefs: number;

  constructor(options: SavedVacancyServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.maxSaved = options.maxSaved ?? MAX_SAVED_VACANCIES;
    this.maxRefs = options.maxRefs ?? MAX_VACANCY_REFS;
  }

  /**
   * Record that a message carrying `vacancies` was delivered to the user, so a
   * later `/save` can resolve it. Re-recording the same message replaces its
   * entries rather than duplicating them.
   */
  async recordDelivered(
    chatId: number,
    messageId: number,
    vacancies: readonly Vacancy[],
  ): Promise<void> {
    if (vacancies.length === 0) return;
    const at = this.now().toISOString();
    await this.store.update((draft) => {
      const kept = draft.vacancyIndex.items.filter(
        (item) => !(item.chatId === chatId && item.messageId === messageId),
      );
      for (const vacancy of vacancies) {
        kept.push({ chatId, messageId, at, vacancy });
      }
      draft.vacancyIndex.items = kept.slice(-this.maxRefs);
    });
  }

  /** Recently delivered vacancy messages for one chat, most recent first. */
  async recentGroups(chatId: number): Promise<RecentVacancyGroup[]> {
    const state = await this.store.get();
    const groups = new Map<number, { at: string; vacancies: Vacancy[] }>();
    for (const item of state.vacancyIndex.items) {
      if (item.chatId !== chatId) continue;
      const existing = groups.get(item.messageId);
      if (existing === undefined) {
        groups.set(item.messageId, { at: item.at, vacancies: [item.vacancy] });
      } else {
        existing.vacancies.push(item.vacancy);
      }
    }
    return [...groups.entries()]
      .map(([messageId, group]) => ({
        messageId,
        at: group.at,
        vacancies: group.vacancies,
      }))
      .reverse();
  }

  /**
   * Save a vacancy for this chat. With no selection, the single vacancy in the
   * most recent vacancy message is saved; a multi-vacancy message asks the user
   * to choose. A reply target (`replyToMessageId`) overrides "most recent".
   */
  async save(
    chatId: number,
    options: { readonly index?: number; readonly replyToMessageId?: number } = {},
  ): Promise<SaveOutcome> {
    const groups = await this.recentGroups(chatId);
    const group =
      options.replyToMessageId === undefined
        ? groups[0]
        : groups.find((candidate) => candidate.messageId === options.replyToMessageId);

    if (group === undefined) return { status: "no_recent_vacancy" };

    if (group.vacancies.length > 1 && options.index === undefined) {
      return {
        status: "selection_required",
        messageId: group.messageId,
        vacancies: group.vacancies,
      };
    }

    const index = options.index ?? 1;
    if (index < 1 || index > group.vacancies.length) {
      return {
        status: "invalid_selection",
        messageId: group.messageId,
        count: group.vacancies.length,
      };
    }

    const vacancy = group.vacancies[index - 1] as Vacancy;
    const key = identityKey(vacancy);

    const state = await this.store.get();
    const existing = state.savedVacancies.entries.find(
      (entry) => entry.chatId === chatId && entry.key === key,
    );
    if (existing !== undefined) {
      if (existing.messageId === undefined) {
        await this.store.update((draft) => {
          const target = draft.savedVacancies.entries.find(
            (entry) => entry.id === existing.id,
          );
          if (target !== undefined) target.messageId = group.messageId;
        });
        return { status: "already_saved", entry: { ...existing, messageId: group.messageId } };
      }
      return { status: "already_saved", entry: existing };
    }

    const savedAt = this.now().toISOString();
    const keys = jobIdentityKeys(vacancy);
    let createdId = -1;
    const after = await this.store.update((draft) => {
      createdId = draft.savedVacancies.nextId;
      draft.savedVacancies.entries.push({
        id: createdId,
        chatId,
        key,
        keys,
        vacancy,
        savedAt,
        messageId: group.messageId,
      });
      draft.savedVacancies.nextId = createdId + 1;
      if (draft.savedVacancies.entries.length > this.maxSaved) {
        draft.savedVacancies.entries = draft.savedVacancies.entries.slice(-this.maxSaved);
      }
    });

    const entry = after.savedVacancies.entries.find((candidate) => candidate.id === createdId);
    return { status: "saved", entry: entry as SavedVacancy };
  }

  /** Saved vacancies for one chat, most recently saved first. */
  async listSaved(chatId: number): Promise<SavedVacancy[]> {
    const state = await this.store.get();
    return state.savedVacancies.entries
      .filter((entry) => entry.chatId === chatId)
      .slice()
      .sort((a, b) => b.id - a.id);
  }

  /** Telegram message ids that must never be deleted by `/empty`. */
  async savedMessageIds(chatId: number): Promise<Set<number>> {
    const state = await this.store.get();
    const ids = new Set<number>();
    for (const entry of state.savedVacancies.entries) {
      if (entry.chatId === chatId && entry.messageId !== undefined) {
        ids.add(entry.messageId);
      }
    }
    return ids;
  }

  /**
   * Drop the `/save` index entries for this chat that point at messages which
   * are no longer kept (i.e. were deleted by `/empty`). Kept message ids - the
   * saved ones - stay resolvable.
   */
  async pruneRefs(chatId: number, keepMessageIds: ReadonlySet<number>): Promise<void> {
    await this.store.update((draft) => {
      draft.vacancyIndex.items = draft.vacancyIndex.items.filter(
        (item) => item.chatId !== chatId || keepMessageIds.has(item.messageId),
      );
    });
  }
}
