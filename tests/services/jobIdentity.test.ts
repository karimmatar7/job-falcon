import { describe, expect, it } from "vitest";
import {
  canonicalUrl,
  identityKey,
  jobIdentityKeys,
} from "../../src/services/scheduling/jobIdentity.js";
import { makeVacancy } from "../testKit.js";

describe("canonicalUrl", () => {
  it("strips www, the fragment and tracking parameters", () => {
    expect(
      canonicalUrl(
        "https://www.Example.com/jobs/1?utm_source=x&foo=bar&gclid=z&src=ad#section",
      ),
    ).toBe("https://example.com/jobs/1?foo=bar");
  });

  it("strips the full utm_ family and known referral parameters", () => {
    expect(
      canonicalUrl("https://example.com/j/9?utm_medium=email&fbclid=q&ref=newsletter&keep=1"),
    ).toBe("https://example.com/j/9?keep=1");
  });

  it("removes trailing slashes and preserves a meaningful query", () => {
    expect(canonicalUrl("https://example.com/jobs/7/")).toBe("https://example.com/jobs/7");
    expect(canonicalUrl("https://example.com/jobs?page=2")).toBe(
      "https://example.com/jobs?page=2",
    );
  });

  it("returns undefined for unusable input", () => {
    expect(canonicalUrl(undefined)).toBeUndefined();
    expect(canonicalUrl("")).toBeUndefined();
    expect(canonicalUrl("   ")).toBeUndefined();
    expect(canonicalUrl("not a url")).toBeUndefined();
    expect(canonicalUrl("ftp://example.com/file")).toBeUndefined();
    expect(canonicalUrl("javascript://alert(1)")).toBeUndefined();
  });
});

describe("identityKey", () => {
  it("normalises employer, title and location into one key", () => {
    expect(identityKey(makeVacancy())).toBe("et:acmeltd||graduatesoftwaredeveloper||sheffield");
  });

  it("collapses punctuation, case and spacing", () => {
    const a = makeVacancy({ employer: "Acme Ltd.", title: "Software Engineer", location: "London, UK" });
    const b = makeVacancy({ employer: "acme ltd", title: "software-engineer", location: "london uk" });
    expect(identityKey(a)).toBe(identityKey(b));
  });
});

describe("jobIdentityKeys", () => {
  it("lists the primary key first, then id and url facets", () => {
    const keys = jobIdentityKeys(makeVacancy());
    expect(keys[0]).toBe("et:acmeltd||graduatesoftwaredeveloper||sheffield");
    expect(keys).toContain("id:test-source:job-1");
    expect(keys).toContain("id:job-1");
    expect(keys).toContain("url:https://example.com/apply/1");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("falls back to the source URL when no application URL exists", () => {
    const vacancy = makeVacancy();
    delete vacancy.applicationUrl;
    const keys = jobIdentityKeys(vacancy);
    expect(keys).toContain("url:https://example.com/jobs/1");
  });

  it("omits a url facet when no usable URL exists", () => {
    const vacancy = makeVacancy({
      sourceUrl: "https://example.com/jobs/1",
      applicationUrl: "not-a-url",
    });
    const keys = jobIdentityKeys(vacancy);
    expect(keys.some((key) => key.startsWith("url:"))).toBe(false);
  });

  it("shares the primary key across sources advertising the same role", () => {
    const adzuna = makeVacancy({
      source: "adzuna",
      id: "ad-1",
      employer: "Acme Ltd",
      title: "Software Engineer",
      location: "London",
      sourceUrl: "https://adzuna.example/1",
      applicationUrl: "https://adzuna.example/apply/1",
    });
    const remotive = makeVacancy({
      source: "remotive",
      id: "rm-1",
      employer: "Acme Ltd",
      title: "Software Engineer",
      location: "London",
      sourceUrl: "https://remotive.example/1",
      applicationUrl: "https://remotive.example/apply/1",
    });

    expect(identityKey(adzuna)).toBe(identityKey(remotive));
    const adzunaKeys = jobIdentityKeys(adzuna);
    const remotiveKeys = jobIdentityKeys(remotive);
    expect(adzunaKeys.filter((key) => remotiveKeys.includes(key))).toEqual([
      identityKey(adzuna),
    ]);
  });
});