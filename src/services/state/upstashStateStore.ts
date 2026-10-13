import { createLogger } from "../../utils/logger.js";
import type { Logger } from "../../utils/logger.js";
import { persistedStateSchema } from "./stateStore.js";
import type { LockableStateStore, PersistedState } from "./stateStore.js";
import { createInitialState } from "./stateStore.js";

/** Namespaced key holding the whole state document. */
export const DEFAULT_UPSTASH_STATE_KEY = "job-scout:state";

/** Compare-and-delete so a run only releases a lock it still owns. */
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

function cloneState(state: PersistedState): PersistedState {
  return structuredClone(state);
}

export interface UpstashStateStoreOptions {
  /** REST URL of the Upstash database, e.g. `https://xxx.upstash.io`. */
  readonly url: string;
  /** REST token (`UPSTASH_REDIS_REST_TOKEN`). Never logged. */
  readonly token: string;
  /** Redis key for the document (defaults to {@link DEFAULT_UPSTASH_STATE_KEY}). */
  readonly key?: string;
  readonly logger?: Logger;
  readonly initial?: PersistedState;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetcher?: typeof fetch;
}

/**
 * Durable state backed by an Upstash Redis REST endpoint.
 *
 * Vercel has no persistent disk, so a file store loses history between cold
 * starts and across instances. This store keeps the same single-JSON-document
 * model as {@link FileStateStore} but persists it in Redis, using no extra npm
 * dependency: commands are plain JSON arrays sent with `fetch`.
 *
 * In-process reads are cached and updates are queued exactly like the file
 * store. Across processes, {@link UpstashStateStore.acquireLock} provides the
 * atomic mutual exclusion the scheduled-search endpoint needs.
 */
export class UpstashStateStore implements LockableStateStore {
  private readonly url: string;
  private readonly token: string;
  private readonly key: string;
  private readonly lockKey: string;
  private readonly logger: Logger;
  private readonly initial: PersistedState;
  private readonly fetcher: typeof fetch;

  private state: PersistedState | undefined;
  private loadPromise: Promise<PersistedState> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: UpstashStateStoreOptions) {
    this.url = options.url.trim().replace(/\/+$/, "");
    this.token = options.token;
    this.key = options.key?.trim() || DEFAULT_UPSTASH_STATE_KEY;
    this.lockKey = `${this.key}:lock`;
    this.logger = options.logger ?? createLogger();
    this.initial = options.initial ?? createInitialState();
    this.fetcher = options.fetcher ?? fetch;
  }

  async get(): Promise<PersistedState> {
    if (this.state !== undefined) return cloneState(this.state);
    this.loadPromise ??= this.load();
    return cloneState(await this.loadPromise);
  }

  update(mutator: (draft: PersistedState) => void): Promise<PersistedState> {
    const run = this.queue.then(async () => {
      const current = await this.get();
      mutator(current);
      const validated = persistedStateSchema.parse(current);
      await this.command(["SET", this.key, JSON.stringify(validated)]);
      this.state = validated;
      return cloneState(validated);
    });
    // Keep the queue alive even when an update rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async acquireLock(owner: string, ttlMs: number): Promise<boolean> {
    const ttl = Math.max(1, Math.ceil(ttlMs));
    const result = await this.command([
      "SET",
      this.lockKey,
      owner,
      "NX",
      "PX",
      ttl,
    ]);
    return result === "OK";
  }

  async releaseLock(owner: string): Promise<void> {
    await this.command(["EVAL", RELEASE_LOCK_SCRIPT, "1", this.lockKey, owner]);
  }

  private async load(): Promise<PersistedState> {
    const raw = await this.command(["GET", this.key]);
    if (typeof raw !== "string") {
      this.state = this.initial;
      return this.state;
    }

    try {
      const parsed = persistedStateSchema.parse(JSON.parse(raw) as unknown);
      this.state = parsed;
      return parsed;
    } catch {
      await this.backupCorrupt(raw);
      this.logger.warn("Remote state was unreadable; starting from defaults", {
        key: this.key,
      });
      this.state = this.initial;
      return this.state;
    }
  }

  private async backupCorrupt(raw: string): Promise<void> {
    try {
      await this.command(["SET", `${this.key}:corrupt:${Date.now()}`, raw]);
    } catch {
      // Best effort only: never block startup on the backup.
    }
  }

  private async command(args: readonly unknown[]): Promise<unknown> {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      throw new Error(`Upstash request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { result?: unknown; error?: unknown };
    if (payload.error !== undefined && payload.error !== null) {
      throw new Error(`Upstash command failed: ${String(payload.error)}`);
    }
    return payload.result;
  }
}
