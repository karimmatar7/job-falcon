import type { StateStore } from "../services/state/stateStore.js";
import type { MessageTracker } from "../services/conversation/messageTracker.js";
import type { Scheduler } from "../services/scheduling/scheduler.js";
import type { Notifier } from "../services/scheduling/notifications.js";
import type { SavedVacancyService } from "../services/savedVacancies.js";

/** Phase 3 services shared by the command handlers. */
export interface BotServices {
  readonly store: StateStore;
  readonly tracker: MessageTracker;
  readonly scheduler: Scheduler;
  readonly notifier: Notifier;
  readonly savedVacancies: SavedVacancyService;
}
