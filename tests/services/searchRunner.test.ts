import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SEARCH_CACHE_TTL_MS,
  createScheduledSearch,
} from "../../src/services/scheduling/searchRunner.js";
import { makeJobSearchResult, silentLogger } from "../testKit.js";

function makeRunner(options: { now?: () => Date; cacheTtlMs?: number } = {}) {
  const service = { search: vi.fn(async () => makeJobSearchResult([])) };
  const runner = createScheduledSearch({
    logger: silentLogger,
    service,
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, runner };
}

const QUERY = { keywords: ["software developer"], limit: 10 };

describe("createScheduledSearch", () => {
  it("delegates to the search service", async () => {
    const { service, runner } = makeRunner();
    const result = await runner(QUERY);
    expect(service.search).toHaveBeenCalledWith(QUERY);
    expect(result.vacancies).toEqual([]);
  });

  it("serves an identical query from cache within the TTL", async () => {
    const now = vi.fn(() => new Date("2026-06-01T09:00:00.000Z"));
    const { service, runner } = makeRunner({ now });

    await runner(QUERY);
    await runner(QUERY);

    expect(service.search).toHaveBeenCalledTimes(1);
  });

  it("calls the service again once the TTL expires", async () => {
    let current = 1_000_000;
    const now = vi.fn(() => new Date(current));
    const { service, runner } = makeRunner({ now });

    await runner(QUERY);
    current += DEFAULT_SEARCH_CACHE_TTL_MS;
    await runner(QUERY);

    expect(service.search).toHaveBeenCalledTimes(2);
  });

  it("treats a different query as a cache miss", async () => {
    const { service, runner } = makeRunner();
    await runner(QUERY);
    await runner({ keywords: ["react"], limit: 5 });
    expect(service.search).toHaveBeenCalledTimes(2);
  });

  it("distinguishes queries by meaningful field values", async () => {
    const { service, runner } = makeRunner();
    await runner({ keywords: ["software", "developer"], limit: 10 });
    await runner({ keywords: ["developer", "software"], limit: 10 });
    expect(service.search).toHaveBeenCalledTimes(2);
  });
});