import { describe, expect, it, vi } from "vitest";
import {
  GovUkSponsorRegister,
  NullSponsorRegister,
  createDefaultSponsorRegister,
  discoverRegisterCsvUrl,
  extractRegisterDate,
  normaliseOrganisation,
  parseSponsorRegisterCsv,
} from "../../src/services/sponsorRegister.js";
import type { Logger } from "../../src/utils/logger.js";

const fixedNow = () => new Date("2026-06-01T00:00:00.000Z");

function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const CSV = [
  "Organisation Name,Town/City,County,Type & Rating,Route",
  'Acme Software Ltd,Sheffield,South Yorkshire,Worker (A rating),Skilled Worker',
  '"Globex, Inc.",London,,Worker (A rating),Skilled Worker',
  "Beta Digital Limited,Leeds,,Worker (A rating),Skilled Worker",
].join("\n");

describe("normaliseOrganisation", () => {
  it("collapses legal suffixes and punctuation", () => {
    expect(normaliseOrganisation("Acme Ltd.")).toBe(normaliseOrganisation("ACME Limited"));
  });

  it("ignores an ampersand-vs-and difference", () => {
    expect(normaliseOrganisation("Bright & Co")).toBe(normaliseOrganisation("Bright and Co"));
  });
});

describe("parseSponsorRegisterCsv", () => {
  it("skips the header and parses quoted names", () => {
    const names = parseSponsorRegisterCsv(CSV);
    expect(names.has(normaliseOrganisation("Acme Software Ltd"))).toBe(true);
    expect(names.has("globex")).toBe(true);
    expect(names.has("organisation name")).toBe(false);
    expect(names.size).toBe(3);
  });
});

describe("GovUkSponsorRegister", () => {
  it("verifies a matching employer and preserves evidence metadata", async () => {
    const fetcher = vi.fn(async () => makeResponse(CSV));
    const register = new GovUkSponsorRegister(fetcher as unknown as typeof fetch, {
      csvUrl: "https://gov.example/register.csv",
      now: fixedNow,
    });

    const result = await register.isLicensedSponsor("Acme Software Limited");

    expect(result.status).toBe("verified");
    expect(result.sourceUrl).toBe("https://gov.example/register.csv");
    expect(result.checkedAt).toBe(fixedNow().toISOString());
    expect(result.evidence).toContain("licensed to sponsor");
    expect(result.evidence).toContain("NOT that this vacancy offers sponsorship");
  });

  it("reports not_found without claiming the employer is unlicensed", async () => {
    const register = new GovUkSponsorRegister(
      (async () => makeResponse(CSV)) as unknown as typeof fetch,
      { csvUrl: "https://gov.example/register.csv", now: fixedNow },
    );

    const result = await register.isLicensedSponsor("Unknown Startup");

    expect(result.status).toBe("not_found");
    expect(result.evidence).toContain("not proof that they are unlicensed");
  });

  it("degrades to unavailable on HTTP failure", async () => {
    const register = new GovUkSponsorRegister(
      (async () => makeResponse("", 503)) as unknown as typeof fetch,
      { csvUrl: "https://gov.example/register.csv", now: fixedNow },
    );

    const result = await register.isLicensedSponsor("Acme Software Ltd");
    expect(result.status).toBe("unavailable");
    expect(result.evidence).toContain("HTTP 503");
  });

  it("caches the register across lookups", async () => {
    const fetcher = vi.fn(async () => makeResponse(CSV));
    const register = new GovUkSponsorRegister(fetcher as unknown as typeof fetch, {
      csvUrl: "https://gov.example/register.csv",
      now: fixedNow,
    });

    await register.isLicensedSponsor("Acme Software Ltd");
    await register.isLicensedSponsor("Beta Digital Ltd");

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry a failed download for every employer (failure back-off)", async () => {
    const fetcher = vi.fn(async () => makeResponse("", 503));
    const register = new GovUkSponsorRegister(fetcher as unknown as typeof fetch, {
      csvUrl: "https://gov.example/register.csv",
      now: fixedNow,
    });

    const first = await register.isLicensedSponsor("Acme Software Ltd");
    const second = await register.isLicensedSponsor("Beta Digital Ltd");

    expect(first.status).toBe("unavailable");
    expect(second.status).toBe("unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retries after the failure back-off window elapses", async () => {
    let now = new Date("2026-06-01T00:00:00.000Z");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeResponse("", 503))
      .mockResolvedValueOnce(makeResponse(CSV));
    const register = new GovUkSponsorRegister(fetcher as unknown as typeof fetch, {
      csvUrl: "https://gov.example/register.csv",
      now: () => now,
    });

    const first = await register.isLicensedSponsor("Acme Software Ltd");
    expect(first.status).toBe("unavailable");

    now = new Date("2026-06-01T00:10:00.000Z");
    const second = await register.isLicensedSponsor("Acme Software Ltd");
    expect(second.status).toBe("verified");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses to match a too-short or generic employer name", async () => {
    const fetcher = vi.fn(async () => makeResponse(CSV));
    const register = new GovUkSponsorRegister(fetcher as unknown as typeof fetch, {
      csvUrl: "https://gov.example/register.csv",
      now: fixedNow,
    });

    const result = await register.isLicensedSponsor("A");
    expect(result.status).toBe("unavailable");
    expect(result.evidence).toContain("too short or too generic");
  });

  it("follows the gov.uk publication page to the newest CSV attachment", async () => {
    const html = [
      '<a href="https://assets.publishing.service.gov.uk/media/aaa/register-2025-06-01.csv">older</a>',
      '<a href="https://assets.publishing.service.gov.uk/media/bbb/register-2026-01-01.csv">newer</a>',
    ].join("\n");
    const fetcher = vi.fn(async (url: string | URL) =>
      String(url).endsWith(".csv") ? makeResponse(CSV) : makeResponse(html),
    );
    const register = new GovUkSponsorRegister(fetcher as unknown as typeof fetch, {
      csvUrl: "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers",
      now: fixedNow,
    });

    const result = await register.isLicensedSponsor("Acme Software Ltd");

    expect(result.status).toBe("verified");
    expect(result.sourceUrl).toContain("register-2026-01-01.csv");
    expect(result.registerUpdatedAt).toBe("2026-01-01");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("register URL discovery", () => {
  it("extracts a publication date from a register filename", () => {
    expect(extractRegisterDate(".../register-of-licensed-sponsors-workers-2026-01-01.csv")).toBe(
      "2026-01-01",
    );
    expect(extractRegisterDate(".../register.csv")).toBeUndefined();
  });

  it("picks the newest CSV link on a page", () => {
    const html = [
      '<a href="https://assets.publishing.service.gov.uk/media/aaa/register-2025-06-01.csv">a</a>',
      '<a href="https://assets.publishing.service.gov.uk/media/bbb/register-2026-01-01.csv">b</a>',
    ].join("\n");
    expect(discoverRegisterCsvUrl(html)).toContain("register-2026-01-01.csv");
  });

  it("returns null when the page has no CSV link", () => {
    expect(discoverRegisterCsvUrl("<html><body>no files here</body></html>")).toBeNull();
  });
});

describe("createDefaultSponsorRegister", () => {
  it("returns a no-op register when no URL is configured", () => {
    const register = createDefaultSponsorRegister({});
    expect(register).toBeInstanceOf(NullSponsorRegister);
    expect(register.enabled).toBe(false);
  });

  it("returns the gov.uk register when a URL is configured", () => {
    const register = createDefaultSponsorRegister({
      UK_SPONSOR_REGISTER_URL: "https://gov.example/register.csv",
    });
    expect(register).toBeInstanceOf(GovUkSponsorRegister);
    expect(register.enabled).toBe(true);
  });

  it("reuses one instance per URL so the snapshot cache survives across searches", () => {
    const url = "https://gov.example/reuse.csv";
    const first = createDefaultSponsorRegister({ UK_SPONSOR_REGISTER_URL: url });
    const second = createDefaultSponsorRegister({ UK_SPONSOR_REGISTER_URL: url });
    expect(second).toBe(first);
  });

  it("keeps injected fetchers isolated", () => {
    const url = "https://gov.example/isolated.csv";
    const fetcher = (async () => makeResponse(CSV)) as unknown as typeof fetch;
    const first = createDefaultSponsorRegister({ UK_SPONSOR_REGISTER_URL: url }, fetcher);
    const second = createDefaultSponsorRegister({ UK_SPONSOR_REGISTER_URL: url }, fetcher);
    expect(second).not.toBe(first);
  });

  it("makes no claims when disabled", async () => {
    const result = await new NullSponsorRegister(fixedNow).isLicensedSponsor("Acme");
    expect(result.status).toBe("unavailable");
    expect(result.evidence).toContain("could not be verified");
  });
});

describe("sponsor register diagnostics", () => {
  interface Recorded {
    readonly level: string;
    readonly message: string;
    readonly details?: unknown;
  }

  function capturing(): { logger: Logger; records: Recorded[] } {
    const records: Recorded[] = [];
    const push =
      (level: string) =>
      (message: string, details?: unknown): void => {
        records.push({ level, message, details });
      };
    return {
      logger: { info: push("info"), warn: push("warn"), error: push("error") },
      records,
    };
  }

  it("logs a loaded snapshot with host and entry count, but no employer data", async () => {
    const { logger, records } = capturing();
    const register = new GovUkSponsorRegister(
      (async () => makeResponse(CSV)) as unknown as typeof fetch,
      { csvUrl: "https://gov.example/register.csv", now: fixedNow, logger },
    );

    await register.isLicensedSponsor("Acme Software Ltd");

    const loaded = records.find((r) => r.message.includes("snapshot loaded"));
    expect(loaded).toBeDefined();
    const details = JSON.stringify(loaded?.details);
    expect(details).toContain("gov.example");
    expect(details).toContain("3");
    expect(details).not.toContain("Acme");
  });

  it("logs a download failure with its reason", async () => {
    const { logger, records } = capturing();
    const register = new GovUkSponsorRegister(
      (async () => makeResponse("", 503)) as unknown as typeof fetch,
      { csvUrl: "https://gov.example/register.csv", now: fixedNow, logger },
    );

    await register.isLicensedSponsor("Acme Software Ltd");

    const failed = records.find((r) => r.message.includes("snapshot unavailable"));
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed?.details)).toContain("HTTP 503");
  });

  it("logs whether the factory enabled or disabled the register", () => {
    const disabled = capturing();
    expect(
      createDefaultSponsorRegister({}, undefined, disabled.logger),
    ).toBeInstanceOf(NullSponsorRegister);
    expect(disabled.records.some((r) => r.message.includes("disabled"))).toBe(true);

    const enabled = capturing();
    const register = createDefaultSponsorRegister(
      { UK_SPONSOR_REGISTER_URL: "https://gov.example/diagnostics.csv" },
      undefined,
      enabled.logger,
    );
    expect(register).toBeInstanceOf(GovUkSponsorRegister);
    expect(enabled.records.some((r) => r.message.includes("enabled"))).toBe(true);
    expect(JSON.stringify(enabled.records)).toContain("gov.example");
  });
});
