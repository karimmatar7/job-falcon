import { describe, expect, it } from "vitest";
import { assessExpiry, DEFAULT_MAX_AGE_DAYS } from "../../src/services/freshness.js";

const now = new Date("2026-06-01T00:00:00.000Z");

describe("assessExpiry", () => {
  it("flags explicit closure markers", () => {
    const result = assessExpiry(
      { title: "React Developer", description: "This position has been filled." },
      now,
    );
    expect(result.expired).toBe(true);
    expect(result.reason).toContain("position has been filled");
  });

  it("flags listings older than the freshness window", () => {
    const old = new Date(now.getTime() - (DEFAULT_MAX_AGE_DAYS + 5) * 24 * 60 * 60 * 1000);
    const result = assessExpiry(
      { title: "React Developer", description: "Great role", datePosted: old.toISOString() },
      now,
    );
    expect(result.expired).toBe(true);
    expect(result.reason).toContain("days ago");
  });

  it("keeps fresh listings", () => {
    const result = assessExpiry(
      { title: "React Developer", datePosted: "2026-05-30T00:00:00.000Z" },
      now,
    );
    expect(result.expired).toBe(false);
  });

  it("never treats a missing or unparseable date as expired", () => {
    expect(assessExpiry({ title: "React Developer" }, now).expired).toBe(false);
    expect(
      assessExpiry({ title: "React Developer", datePosted: "not-a-date" }, now).expired,
    ).toBe(false);
  });

  it("honours a custom max age", () => {
    const result = assessExpiry(
      { title: "React Developer", datePosted: "2026-05-01T00:00:00.000Z" },
      now,
      7,
    );
    expect(result.expired).toBe(true);
  });
});
