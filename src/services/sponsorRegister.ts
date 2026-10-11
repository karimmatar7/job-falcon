/**
 * Authoritative employer sponsor-status verification.
 *
 * The UK government publishes the "Register of licensed sponsors: workers" at
 * https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
 * as a versioned CSV attachment. Membership of that register proves only that
 * an *employer* is licensed to sponsor; it does **not** prove that any specific
 * vacancy offers sponsorship. This module therefore returns an employer-capability
 * fact that is stored separately from the vacancy-level verdict and can never
 * upgrade a vacancy to `vacancy_sponsorship_confirmed`.
 *
 * The adapter is opt-in: it only performs a network fetch when an explicit
 * `UK_SPONSOR_REGISTER_URL` is configured. The URL may be a direct CSV export
 * *or* the gov.uk publication page itself, in which case the newest CSV
 * attachment is discovered automatically (the media URL changes on every
 * update, so the page is the stable entry point). Without a URL, verification
 * degrades to `unavailable` and nothing is claimed.
 */

import type { Logger } from "../utils/logger.js";

export type SponsorRegisterStatus = "verified" | "not_found" | "unavailable";

export interface SponsorRegisterResult {
  readonly status: SponsorRegisterStatus;
  readonly evidence: string;
  /** The register URL the evidence was actually read from. */
  readonly sourceUrl: string;
  /** When this verification was performed. */
  readonly checkedAt: string;
  /** The register's own name for the matched entry, when verified. */
  readonly matchedEntry?: string;
  /** When the register snapshot was downloaded and parsed. */
  readonly retrievedAt?: string;
  /** The register snapshot's publication date, when it could be determined. */
  readonly registerUpdatedAt?: string;
}

export interface SponsorRegister {
  readonly name: string;
  readonly enabled: boolean;
  isLicensedSponsor(employer: string): Promise<SponsorRegisterResult>;
}

export const DEFAULT_REGISTER_TIMEOUT_MS = 10_000;
export const DEFAULT_REGISTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * After a download failure the register is not retried for this long, so a
 * misconfigured URL or an outage cannot trigger a request per vacancy.
 */
export const DEFAULT_REGISTER_FAILURE_TTL_MS = 5 * 60 * 1000;

/** A single parsed register row (only the columns we use). */
export interface RegisterEntry {
  readonly name: string;
  readonly town: string;
  readonly county: string;
  readonly rating: string;
  readonly route: string;
}

/**
 * Normalise an organisation name for comparison: lowercase, strip punctuation,
 * accents and common legal/structural suffixes so that "Acme Ltd" and
 * "ACME Limited" collapse to the same key. This is intentionally conservative:
 * only exact normalised equality is treated as a match, never fuzzy similarity.
 */
export function normaliseOrganisation(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(
      /\b(ltd|limited|plc|llp|inc|incorporated|corp|corporation|company|co|holdings|group|the)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the first column (organisation name) from a CSV line, honouring quotes. */
export function firstCsvField(line: string): string {
  return parseCsvLine(line)[0] ?? "";
}

/**
 * Split one CSV line into cells using RFC 4180-style quoting (double quotes,
 * escaped by doubling). Multi-line quoted fields are not expected in this
 * register, so parsing is line-oriented.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Parse the government CSV export into a map keyed by normalised organisation
 * name. Only the first row for a given key is kept, so duplicate legal names do
 * not create ambiguity.
 */
export function parseSponsorRegisterCsv(csv: string): Map<string, RegisterEntry> {
  const entries = new Map<string, RegisterEntry>();
  const text = csv.replace(/^\uFEFF/, "");

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) continue;
    const cells = parseCsvLine(rawLine);
    const name = (cells[0] ?? "").trim();
    if (name.length === 0) continue;
    if (/^organisation name$/i.test(name)) continue;

    const key = normaliseOrganisation(name);
    if (key.length < 2 || entries.has(key)) continue;

    entries.set(key, {
      name,
      town: (cells[1] ?? "").trim(),
      county: (cells[2] ?? "").trim(),
      rating: (cells[3] ?? "").trim(),
      route: (cells[4] ?? "").trim(),
    });
  }
  return entries;
}

/** A safe default: makes no claims and performs no network calls. */
export class NullSponsorRegister implements SponsorRegister {
  readonly name = "none";
  readonly enabled = false;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async isLicensedSponsor(employer: string): Promise<SponsorRegisterResult> {
    return {
      status: "unavailable",
      evidence:
        `Employer capability for "${employer}" could not be verified because no ` +
        `UK sponsor register is configured (UK_SPONSOR_REGISTER_URL is unset).`,
      sourceUrl: "",
      checkedAt: this.now().toISOString(),
    };
  }
}

export interface GovUkSponsorRegisterOptions {
  readonly csvUrl: string;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  /** How long a failed download is remembered before retrying. */
  readonly failureCacheTtlMs?: number;
  readonly now?: () => Date;
  /** Optional diagnostics sink; only hosts, counts and reasons are logged. */
  readonly logger?: Logger;
}

interface RegisterCacheEntry {
  readonly entries: Map<string, RegisterEntry>;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly registerUpdatedAt?: string;
}

type LoadResult =
  | ({ readonly ok: true } & RegisterCacheEntry)
  | { readonly ok: false; readonly reason: string };

type FetchTextResult =
  | { readonly ok: true; readonly text: string; readonly contentType: string; readonly lastModified?: string }
  | { readonly ok: false; readonly reason: string };

/** The stable publication page for the workers' register. */
export const REGISTER_PUBLICATION_URL =
  "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers";

export class GovUkSponsorRegister implements SponsorRegister {
  readonly name = "uk-sponsor-register";
  readonly enabled = true;

  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;

  private cache: {
    entries: Map<string, RegisterEntry>;
    sourceUrl: string;
    retrievedAt: string;
    registerUpdatedAt?: string;
  } | null = null;
  private loadedAt = 0;
  private lastFailure: { at: number; reason: string } | null = null;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly options: GovUkSponsorRegisterOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_REGISTER_CACHE_TTL_MS;
    this.failureTtlMs = options.failureCacheTtlMs ?? DEFAULT_REGISTER_FAILURE_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  async isLicensedSponsor(employer: string): Promise<SponsorRegisterResult> {
    const checkedAt = this.now().toISOString();
    const loaded = await this.load();

    if (!loaded.ok) {
      return {
        status: "unavailable",
        evidence:
          `Could not load the UK register of licensed sponsors (${loaded.reason}); ` +
          `employer capability for "${employer}" is unverified.`,
        sourceUrl: this.options.csvUrl,
        checkedAt,
      };
    }

    const key = normaliseOrganisation(employer);
    if (key.length < 2) {
      return {
        status: "unavailable",
        evidence:
          `Employer name "${employer}" is too short or too generic to match reliably on the ` +
          `UK register of licensed sponsors, so its capability is unverified.`,
        sourceUrl: loaded.sourceUrl,
        checkedAt,
        retrievedAt: loaded.retrievedAt,
        ...(loaded.registerUpdatedAt === undefined
          ? {}
          : { registerUpdatedAt: loaded.registerUpdatedAt }),
      };
    }

    const entry = loaded.entries.get(key);
    if (entry !== undefined) {
      const route = [entry.route, entry.rating].filter((v) => v.length > 0).join(", ");
      const routeNote = route.length > 0 ? ` (${route})` : "";
      return {
        status: "verified",
        evidence:
          `Employer "${employer}" matches "${entry.name}"${routeNote} on the UK register of ` +
          `licensed sponsors. This confirms the employer is licensed to sponsor, NOT that this ` +
          `vacancy offers sponsorship.`,
        sourceUrl: loaded.sourceUrl,
        checkedAt,
        matchedEntry: entry.name,
        retrievedAt: loaded.retrievedAt,
        ...(loaded.registerUpdatedAt === undefined
          ? {}
          : { registerUpdatedAt: loaded.registerUpdatedAt }),
      };
    }

    return {
      status: "not_found",
      evidence:
        `Employer "${employer}" was not found on the fetched UK register of licensed sponsors. ` +
        `Employers can sponsor under a different legal or trading name, so this is not proof ` +
        `that they are unlicensed.`,
      sourceUrl: loaded.sourceUrl,
      checkedAt,
      retrievedAt: loaded.retrievedAt,
      ...(loaded.registerUpdatedAt === undefined
        ? {}
        : { registerUpdatedAt: loaded.registerUpdatedAt }),
    };
  }

  private async load(): Promise<
    | { ok: true; entries: Map<string, RegisterEntry>; sourceUrl: string; retrievedAt: string; registerUpdatedAt?: string }
    | { ok: false; reason: string }
  > {
    const now = this.now().getTime();
    if (this.cache !== null && now - this.loadedAt < this.cacheTtlMs) {
      return { ok: true, ...this.cache };
    }

    // Back off after a failed download so a broken or misconfigured URL does
    // not cause a network request for every employer in a search.
    if (this.lastFailure !== null && now - this.lastFailure.at < this.failureTtlMs) {
      this.logger?.info("Sponsor register: download skipped after a recent failure", {
        source: registerHost(this.options.csvUrl),
        retryInMs: Math.max(0, this.failureTtlMs - (now - this.lastFailure.at)),
      });
      return { ok: false, reason: this.lastFailure.reason };
    }

    const result = await this.loadUncached(now);
    if (result.ok) {
      this.lastFailure = null;
    } else {
      this.lastFailure = { at: now, reason: result.reason };
      this.logger?.warn("Sponsor register: snapshot unavailable", {
        source: registerHost(this.options.csvUrl),
        reason: result.reason,
      });
    }
    return result;
  }

  private async loadUncached(now: number): Promise<
    | { ok: true; entries: Map<string, RegisterEntry>; sourceUrl: string; retrievedAt: string; registerUpdatedAt?: string }
    | { ok: false; reason: string }
  > {
    this.logger?.info("Sponsor register: downloading snapshot", {
      source: registerHost(this.options.csvUrl),
    });
    const first = await this.fetchText(this.options.csvUrl);
    if (!first.ok) return first;

    let csvText = first.text;
    let sourceUrl = this.options.csvUrl;
    let registerUpdatedAt =
      extractRegisterDate(this.options.csvUrl) ?? first.lastModified;

    // The publication page is HTML; discover and follow the newest CSV attachment.
    if (looksLikeHtml(first.contentType, csvText)) {
      const discovered = discoverRegisterCsvUrl(csvText);
      if (discovered === null) {
        return {
          ok: false,
          reason: "no CSV download link found on the configured register page",
        };
      }
      const second = await this.fetchText(discovered);
      if (!second.ok) return second;
      if (looksLikeHtml(second.contentType, second.text)) {
        return { ok: false, reason: "discovered register link was not a CSV file" };
      }
      csvText = second.text;
      sourceUrl = discovered;
      registerUpdatedAt = extractRegisterDate(discovered) ?? second.lastModified;
    }

    const entries = parseSponsorRegisterCsv(csvText);
    if (entries.size === 0) {
      return { ok: false, reason: "register contained no usable rows" };
    }

    const retrievedAt = this.now().toISOString();
    this.cache = {
      entries,
      sourceUrl,
      retrievedAt,
      ...(registerUpdatedAt === undefined ? {} : { registerUpdatedAt }),
    };
    this.loadedAt = now;

    this.logger?.info("Sponsor register: snapshot loaded", {
      source: registerHost(sourceUrl),
      entries: entries.size,
      ...(registerUpdatedAt === undefined ? {} : { registerUpdatedAt }),
    });

    return { ok: true, ...this.cache };
  }

  private async fetchText(url: string): Promise<FetchTextResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: { accept: "text/csv, text/html, text/plain, */*" },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, reason: `HTTP ${response.status}` };
      }
      const text = await response.text();
      const contentType = response.headers?.get?.("content-type") ?? "";
      const lastModified = response.headers?.get?.("last-modified") ?? undefined;
      return {
        ok: true,
        text,
        contentType,
        ...(lastModified === null || lastModified === undefined ? {} : { lastModified }),
      };
    } catch (error) {
      return { ok: false, reason: describeFetchError(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True when a response looks like an HTML page rather than a CSV export. */
export function looksLikeHtml(contentType: string, text: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  return /^\s*</.test(text.slice(0, 200));
}

/**
 * Find the newest CSV attachment on the gov.uk publication page. Media URLs
 * change on every update, so the page (not a fixed URL) is the stable source.
 */
export function discoverRegisterCsvUrl(html: string): string | null {
  const matches = [
    ...html.matchAll(
      /https:\/\/assets\.publishing\.service\.gov\.uk\/media\/[^\s"'<>]+?\.csv/gi,
    ),
  ].map((match) => match[0]);
  if (matches.length === 0) return null;

  let best = matches[0]!;
  let bestDate = extractRegisterDate(best) ?? "";
  for (const url of matches.slice(1)) {
    const date = extractRegisterDate(url) ?? "";
    if (date > bestDate) {
      best = url;
      bestDate = date;
    }
  }
  return best;
}

/** Extract a `YYYY-MM-DD` publication date from a register filename, if present. */
export function extractRegisterDate(url: string): string | undefined {
  const match = /(\d{4}-\d{2}-\d{2})(?=[^\d]*\.csv)/i.exec(url);
  return match?.[1];
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "request timed out";
    }
    return error.message;
  }
  return String(error);
}

/**
 * Build the register verifier from the environment. Disabled unless
 * `UK_SPONSOR_REGISTER_URL` points at the official CSV export or the gov.uk
 * publication page (from which the newest CSV is discovered).
 *
 * In production (the default global `fetch`) the built instance is memoised per
 * URL so the downloaded snapshot cache survives across `/search` calls; a
 * custom fetcher always gets a fresh instance so tests stay isolated.
 */
const defaultRegisters = new Map<string, SponsorRegister>();

/** Host of a register URL for diagnostics (never the full configured value). */
function registerHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

export function createDefaultSponsorRegister(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
  logger?: Logger,
): SponsorRegister {
  const url = (env.UK_SPONSOR_REGISTER_URL ?? "").trim();
  if (url.length === 0) {
    logger?.info(
      "Sponsor register: disabled (UK_SPONSOR_REGISTER_URL is unset); employer licence will not be checked",
    );
    return new NullSponsorRegister();
  }

  const options: GovUkSponsorRegisterOptions = {
    csvUrl: url,
    ...(logger === undefined ? {} : { logger }),
  };

  // A custom fetcher always gets a fresh instance so tests stay isolated.
  if (fetcher !== fetch) return new GovUkSponsorRegister(fetcher, options);

  const cached = defaultRegisters.get(url);
  if (cached !== undefined) {
    logger?.info("Sponsor register: enabled (reusing cached snapshot loader)", {
      source: registerHost(url),
    });
    return cached;
  }

  const register = new GovUkSponsorRegister(fetcher, options);
  defaultRegisters.set(url, register);
  logger?.info("Sponsor register: enabled", { source: registerHost(url) });
  return register;
}
