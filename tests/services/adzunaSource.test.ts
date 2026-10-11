import { describe, expect, it, vi } from "vitest";
import {
  AdzunaSource,
  DEFAULT_MAX_DAYS_OLD,
  DEFAULT_RESULTS_PER_PAGE,
} from "../../src/services/sources/adzuna.js";
import type { Logger } from "../../src/utils/logger.js";

const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "12345",
    title: "Junior React Developer",
    company: { display_name: "Acme Ltd" },
    location: { display_name: "Sheffield, South Yorkshire" },
    description: "<p>We are able to sponsor a Skilled Worker visa.</p>",
    redirect_url: "https://www.adzuna.co.uk/jobs/details/12345",
    created: "2026-05-30T00:00:00Z",
    ...overrides,
  };
}

function makeSource(fetcher: typeof fetch): AdzunaSource {
  return new AdzunaSource(
    { appId: "app-id", appKey: "app-key", country: "gb" },
    silentLogger,
    fetcher,
    10_000,
    0,
  );
}

function fetcherReturning(payload: unknown): typeof fetch {
  return (async () => makeResponse(200, JSON.stringify(payload))) as unknown as typeof fetch;
}

describe("AdzunaSource", () => {
  it("maps results into vacancies with sponsorship classification", async () => {
    const payload = { results: [job(), job({ id: "2", title: "Senior Developer" })] };
    const source = makeSource(fetcherReturning(payload));

    const vacancies = await source.search({ keywords: ["react"], location: "sheffield" });

    expect(vacancies).toHaveLength(2);
    expect(vacancies[0]?.source).toBe("adzuna");
    expect(vacancies[0]?.applicationUrl).toBe("https://www.adzuna.co.uk/jobs/details/12345");
    expect(vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(vacancies[0]?.employer).toBe("Acme Ltd");
  });

  it("maps salary fields into the vacancy", async () => {
    const source = makeSource(
      fetcherReturning({ results: [job({ salary_min: 30000, salary_max: 40000 })] }),
    );

    const vacancies = await source.search({});

    expect(vacancies[0]?.salary).toBe("£30,000 - £40,000");
  });

  it("builds the UK search URL with auth, pagination defaults and freshness", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      requested.push(url);
      return makeResponse(200, JSON.stringify({ results: [] }));
    });
    const source = makeSource(fetcher as unknown as typeof fetch);

    await source.search({ keywords: ["react", "frontend"], location: "leeds" });

    const url = requested[0] ?? "";
    expect(url).toContain("/jobs/gb/search/1");
    // Adzuna authenticates via app_id/app_key query parameters (official docs).
    expect(url).toContain("app_id=app-id");
    expect(url).toContain("app_key=app-key");
    expect(url).toContain(`results_per_page=${DEFAULT_RESULTS_PER_PAGE}`);
    expect(url).toContain(`max_days_old=${DEFAULT_MAX_DAYS_OLD}`);
    expect(url).toContain("content-type=application%2Fjson");
    expect(url).toContain("what=react+frontend");
    expect(url).toContain("where=leeds");
  });

  it("uses the configured country and disables max_days_old when set to 0", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      requested.push(url);
      return makeResponse(200, JSON.stringify({ results: [] }));
    });
    const source = new AdzunaSource(
      { appId: "app-id", appKey: "app-key", country: "ie", maxDaysOld: 0 },
      silentLogger,
      fetcher as unknown as typeof fetch,
      10_000,
      0,
    );

    await source.search({});

    expect(requested[0]).toContain("/jobs/ie/search/1");
    expect(requested[0]).not.toContain("max_days_old");
  });

  it("paginates across pages and stops early on a short page", async () => {
    const pages = [
      makeResponse(200, JSON.stringify({ results: [job(), job()] })),
      makeResponse(200, JSON.stringify({ results: [job({ id: "3" })] })),
    ];
    const requested: string[] = [];
    let call = 0;
    const fetcher = async (url: string) => {
      requested.push(url);
      return pages[Math.min(call++, pages.length - 1)] ?? makeResponse(500, "");
    };
    const source = new AdzunaSource(
      { appId: "app-id", appKey: "app-key", resultsPerPage: 2, maxPages: 3 },
      silentLogger,
      fetcher as unknown as typeof fetch,
      10_000,
      0,
    );

    const vacancies = await source.search({});

    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain("/search/1");
    expect(requested[1]).toContain("/search/2");
    expect(vacancies).toHaveLength(3);
  });

  it("returns collected results when a later page fails", async () => {
    let call = 0;
    const fetcher = async () => {
      call += 1;
      if (call === 1) return makeResponse(200, JSON.stringify({ results: [job(), job()] }));
      throw new Error("page two unavailable");
    };
    const source = new AdzunaSource(
      { appId: "app-id", appKey: "app-key", resultsPerPage: 2, maxPages: 2 },
      silentLogger,
      fetcher as unknown as typeof fetch,
      10_000,
      0,
    );

    const vacancies = await source.search({});

    expect(vacancies).toHaveLength(2);
  });

  it("drops records missing required fields", async () => {
    const payload = { results: [job({ redirect_url: "" }), job({ company: {} })] };
    const source = makeSource(fetcherReturning(payload));

    await expect(source.search({})).resolves.toEqual([]);
  });

  it("never uses a source homepage as the application URL", async () => {
    const source = makeSource(
      fetcherReturning({ results: [job({ redirect_url: "https://www.adzuna.co.uk/" })] }),
    );

    const vacancies = await source.search({});

    expect(vacancies).toHaveLength(1);
    expect(vacancies[0]?.applicationUrl).toBeUndefined();
    expect(vacancies[0]?.applicationUrlNote).toContain("homepage");
    expect(vacancies[0]?.sourceUrl).toBe("https://www.adzuna.co.uk/");
  });

  it("throws a source error on malformed JSON", async () => {
    const source = makeSource((async () => makeResponse(200, "{not json")) as unknown as typeof fetch);
    await expect(source.search({})).rejects.toThrow(/malformed JSON response/);
  });

  it("maps timeouts to a source error", async () => {
    const fetcher = (async () => {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const source = makeSource(fetcher);

    await expect(source.search({})).rejects.toThrow(/request timed out/);
  });

  it("reports authentication failures clearly", async () => {
    const source = makeSource(
      (async () =>
        makeResponse(401, JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }))) as unknown as typeof fetch,
    );
    await expect(source.search({})).rejects.toThrow(/HTTP 401/);
    await expect(source.search({})).rejects.toThrow(/authentication failed/);
  });

  it("reports rate limiting clearly", async () => {
    const source = makeSource((async () => makeResponse(429, "")) as unknown as typeof fetch);
    await expect(source.search({})).rejects.toThrow(/HTTP 429/);
    await expect(source.search({})).rejects.toThrow(/rate limited/);
  });

  it("throws a source error on HTTP failure", async () => {
    const source = makeSource((async () => makeResponse(503, "")) as unknown as typeof fetch);
    await expect(source.search({})).rejects.toThrow(/HTTP 503/);
  });
});