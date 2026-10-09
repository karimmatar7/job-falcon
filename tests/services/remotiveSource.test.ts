import { describe, expect, it } from "vitest";
import { RemotiveSource } from "../../src/services/sources/remotive.js";
import type { Logger } from "../../src/utils/logger.js";

interface LogRecord {
  level: string;
  message: string;
  details?: unknown;
}

function makeLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    logger: {
      info: (message, details) => records.push({ level: "info", message, details }),
      warn: (message, details) => records.push({ level: "warn", message, details }),
      error: (message, details) => records.push({ level: "error", message, details }),
    },
  };
}

function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function stubFetcher(response: Response): typeof fetch {
  return async () => response;
}

function makeSource(logger: Logger, fetcher: typeof fetch, timeoutMs = 10_000): RemotiveSource {
  return new RemotiveSource(logger, fetcher, timeoutMs, 0);
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    url: "https://remotive.com/remote-jobs/software-dev/example-1",
    title: "Software Developer",
    company_name: "Acme Ltd",
    candidate_required_location: "UK",
    publication_date: "2026-01-02T00:00:00",
    salary: "GBP 40000",
    description: "<p>We will sponsor a Skilled Worker visa for the right candidate.</p>",
    ...overrides,
  };
}

describe("RemotiveSource", () => {
  it("parses successful responses into vacancies", async () => {
    const { logger } = makeLogger();
    const payload = {
      jobs: [
        job(),
        job({
          id: 2,
          url: "https://remotive.com/remote-jobs/software-dev/example-2",
          title: "Frontend Developer",
          company_name: "Globex",
        }),
      ],
    };
    const source = makeSource(logger, stubFetcher(makeResponse(200, JSON.stringify(payload))));

    const vacancies = await source.search({});

    expect(vacancies).toHaveLength(2);
    expect(vacancies[0]?.source).toBe("remotive");
    expect(vacancies[0]?.applicationUrl).toBe("https://remotive.com/remote-jobs/software-dev/example-1");
    expect(vacancies[0]?.vacancySponsorshipStatus).toBe("confirmed");
    expect(vacancies[0]?.sponsorshipEvidence).toContain("will sponsor");
  });

  it("returns an empty array for an empty response", async () => {
    const { logger } = makeLogger();
    const source = makeSource(logger, stubFetcher(makeResponse(200, JSON.stringify({ jobs: [] }))),
    );

    await expect(source.search({})).resolves.toEqual([]);
  });

  it("rejects malformed JSON with a source error", async () => {
    const { logger } = makeLogger();
    const source = makeSource(logger, stubFetcher(makeResponse(200, "<<not json>>")));

    await expect(source.search({})).rejects.toThrow(/malformed JSON/);
  });

  it("rejects on HTTP errors and logs the status", async () => {
    const { logger, records } = makeLogger();
    const source = makeSource(logger, stubFetcher(makeResponse(503, "")));

    await expect(source.search({})).rejects.toThrow(/HTTP 503/);

    const failure = records.find(record => record.message === "Job source returned non-OK status");
    expect(failure?.details).toMatchObject({ source: "remotive", status: 503 });
  });

  it("rejects when the request times out", async () => {
    const { logger } = makeLogger();
    const slowFetcher: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const source = makeSource(logger, slowFetcher, 10);

    await expect(source.search({})).rejects.toThrow(/timed out/);
  });

  it("treats an inaccessible source page as a source error", async () => {
    const { logger, records } = makeLogger();
    const failingFetcher: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND remotive.com");
    };
    const source = makeSource(logger, failingFetcher);

    await expect(source.search({})).rejects.toThrow(/ENOTFOUND/);

    const failure = records.find(record => record.message === "Job source request failed");
    expect(failure?.details).toMatchObject({ source: "remotive" });
  });

  it("keeps a missing description unclear without inventing evidence", async () => {
    const { logger } = makeLogger();
    const payload = { jobs: [job({ description: undefined })] };
    const source = makeSource(logger, stubFetcher(makeResponse(200, JSON.stringify(payload))));

    const vacancies = await source.search({});

    expect(vacancies).toHaveLength(1);
    expect(vacancies[0]?.vacancySponsorshipStatus).toBe("unclear");
    expect(vacancies[0]?.description).toBeUndefined();
    expect(vacancies[0]?.sponsorshipEvidence).toContain("silence about sponsorship");
  });

  it("marks an explicit visa-assistance refusal as not offered", async () => {
    const { logger } = makeLogger();
    const payload = {
      jobs: [job({ description: "<p>We do not provide visa assistance at this time.</p>" })],
    };
    const source = makeSource(logger, stubFetcher(makeResponse(200, JSON.stringify(payload))));

    const vacancies = await source.search({});

    expect(vacancies[0]?.vacancySponsorshipStatus).toBe("not_offered");
  });

  it("enforces a minimum interval between requests", async () => {
    const { logger } = makeLogger();
    const source = new RemotiveSource(
      logger,
      stubFetcher(makeResponse(200, JSON.stringify({ jobs: [] }))),
      10_000,
      40,
    );

    const startedAt = Date.now();
    await source.search({});
    await source.search({});

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("rejects records missing required fields and reports reasons", async () => {
    const { logger, records } = makeLogger();
    const payload = {
      jobs: [
        { url: "", title: "No URL", company_name: "X" },
        { url: "https://remotive.com/jobs/2", title: "", company_name: "X" },
        { url: "https://remotive.com/jobs/3", title: "Title", company_name: "" },
      ],
    };
    const source = makeSource(logger, stubFetcher(makeResponse(200, JSON.stringify(payload))));

    const vacancies = await source.search({});

    expect(vacancies).toEqual([]);
    const parsed = records.find(record => record.message === "Job source parsed listings");
    expect(parsed?.details).toMatchObject({ received: 3, parsed: 0 });
    expect(parsed?.details).toHaveProperty("rejected.missing_or_invalid_url", 1);
    expect(parsed?.details).toHaveProperty("rejected.missing_title", 1);
    expect(parsed?.details).toHaveProperty("rejected.missing_employer", 1);
  });

  it("keeps employer licence status separate from confirmed sponsorship", async () => {
    const { logger } = makeLogger();
    const payload = {
      jobs: [job({ description: "<p>We hold a sponsor licence and are an approved employer.</p>" })],
    };
    const source = makeSource(logger, stubFetcher(makeResponse(200, JSON.stringify(payload))));

    const vacancies = await source.search({});

    expect(vacancies).toHaveLength(1);
    expect(vacancies[0]?.vacancySponsorshipStatus).toBe("unclear");
    expect(vacancies[0]?.employerSponsorLicence).toBe("yes");
  });

  it("logs diagnostics with source name, status, and counts", async () => {
    const { logger, records } = makeLogger();
    const source = makeSource(logger, stubFetcher(makeResponse(200, JSON.stringify({ jobs: [job()] }))),
    );

    await source.search({});

    expect(records.find(record => record.message === "Job source request succeeded")?.details).toMatchObject(
      { source: "remotive", status: 200 },
    );
    expect(records.find(record => record.message === "Job source records received")?.details).toMatchObject(
      { source: "remotive", status: 200, records: 1 },
    );
  });
});
