import { DEFAULT_UPSTASH_STATE_KEY } from "./upstashStateStore.js";

/**
 * Decide which {@link StateStore} a deployment should use.
 *
 * Local development keeps the durable file in `./data`. Serverless deployments
 * have no persistent disk, so when an Upstash database is configured the state
 * document is stored there instead (see `upstashStateStore.ts`). Selection is
 * explicit through `JOB_SCOUT_STATE_BACKEND`, or automatic when both Upstash
 * credentials are present.
 */
export type StateBackend =
  | { readonly kind: "memory" }
  | { readonly kind: "file" }
  | {
      readonly kind: "upstash";
      readonly url: string;
      readonly token: string;
      readonly key: string;
    };

function readUpstash(
  env: Record<string, string | undefined>,
): { url: string; token: string; key: string } | undefined {
  const url = (env.UPSTASH_REDIS_REST_URL ?? "").trim();
  const token = (env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  if (url.length === 0 || token.length === 0) return undefined;
  const key = (env.JOB_SCOUT_STATE_REDIS_KEY ?? "").trim() || DEFAULT_UPSTASH_STATE_KEY;
  return { url, token, key };
}

export function resolveStateBackend(
  env: Record<string, string | undefined> = process.env,
): StateBackend {
  const explicit = (env.JOB_SCOUT_STATE_BACKEND ?? "").trim().toLowerCase();

  if (explicit === "memory") return { kind: "memory" };
  if (explicit === "file") return { kind: "file" };

  if (explicit === "upstash") {
    const upstash = readUpstash(env);
    if (upstash === undefined) {
      throw new Error(
        "JOB_SCOUT_STATE_BACKEND=upstash requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN",
      );
    }
    return { kind: "upstash", ...upstash };
  }

  if (explicit.length > 0) {
    throw new Error(
      `Unknown JOB_SCOUT_STATE_BACKEND "${explicit}" (expected file, memory or upstash)`,
    );
  }

  // No explicit choice: use Upstash when it is fully configured, else a file.
  const upstash = readUpstash(env);
  if (upstash !== undefined) return { kind: "upstash", ...upstash };
  return { kind: "file" };
}
