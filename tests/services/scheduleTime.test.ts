import { describe, expect, it } from "vitest";
import {
  formatRelative,
  formatWallClock,
  isValidScheduleTime,
  isValidTimeZone,
  nextRunAfter,
  parseScheduleTime,
  zonedTimeToUtc,
} from "../../src/services/scheduling/scheduleTime.js";

describe("parseScheduleTime", () => {
  it("parses valid 24-hour times", () => {
    expect(parseScheduleTime("08:00")).toEqual({ hour: 8, minute: 0 });
    expect(parseScheduleTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseScheduleTime("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseScheduleTime(" 07:30 ")).toEqual({ hour: 7, minute: 30 });
  });

  it("rejects malformed times", () => {
    expect(parseScheduleTime("8:00")).toBeNull();
    expect(parseScheduleTime("24:00")).toBeNull();
    expect(parseScheduleTime("08:60")).toBeNull();
    expect(parseScheduleTime("08:0")).toBeNull();
    expect(parseScheduleTime("noon")).toBeNull();
    expect(parseScheduleTime("")).toBeNull();
    expect(parseScheduleTime("08:00 pm")).toBeNull();
  });
});

describe("isValidScheduleTime", () => {
  it("distinguishes valid from invalid", () => {
    expect(isValidScheduleTime("08:00")).toBe(true);
    expect(isValidScheduleTime("24:00")).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("accepts recognised IANA zones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
  });

  it("rejects unknown, empty and malformed zones", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
    expect(isValidTimeZone("GMT+1")).toBe(false);
  });
});

describe("zonedTimeToUtc", () => {
  it("converts a summer wall-clock time with the DST offset", () => {
    const instant = zonedTimeToUtc(2026, 6, 1, 8, 0, "Europe/London");
    expect(instant.toISOString()).toBe("2026-06-01T07:00:00.000Z");
  });

  it("converts a wall-clock time on the spring-forward day", () => {
    // 29 March 2026 is the spring-forward transition in Europe/London.
    const instant = zonedTimeToUtc(2026, 3, 29, 8, 0, "Europe/London");
    expect(instant.toISOString()).toBe("2026-03-29T07:00:00.000Z");
  });

  it("converts a wall-clock time on the fall-back day", () => {
    // 25 October 2026 is the fall-back transition in Europe/London.
    const instant = zonedTimeToUtc(2026, 10, 25, 8, 0, "Europe/London");
    expect(instant.toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });
});

describe("nextRunAfter", () => {
  it("returns today when the time is still ahead", () => {
    const next = nextRunAfter("08:00", "UTC", new Date("2026-06-01T07:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-01T08:00:00.000Z");
  });

  it("returns tomorrow when the time has passed", () => {
    const next = nextRunAfter("08:00", "UTC", new Date("2026-06-01T09:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-02T08:00:00.000Z");
  });

  it("always returns a time strictly after `from`", () => {
    const next = nextRunAfter(
      "08:00",
      "UTC",
      new Date("2026-06-01T08:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-06-02T08:00:00.000Z");
  });

  it("crosses midnight for a very early time", () => {
    const next = nextRunAfter("00:15", "UTC", new Date("2026-06-01T23:30:00.000Z"));
    expect(next.toISOString()).toBe("2026-06-02T00:15:00.000Z");
  });

  it("keeps the local wall clock across the spring-forward transition", () => {
    // Saturday 28 March 2026: the run after this lands on the DST change day
    // and must still be 08:00 local time (07:00 UTC in BST).
    const next = nextRunAfter(
      "08:00",
      "Europe/London",
      new Date("2026-03-28T12:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(formatWallClock(next, "Europe/London")).toBe("2026-03-29 08:00");
  });

  it("keeps the local wall clock across the fall-back transition", () => {
    // Saturday 24 October 2026: after the clocks go back, 08:00 is UTC+0.
    const next = nextRunAfter(
      "08:00",
      "Europe/London",
      new Date("2026-10-24T12:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    expect(formatWallClock(next, "Europe/London")).toBe("2026-10-25 08:00");
  });

  it("throws on an invalid time", () => {
    expect(() => nextRunAfter("9:00", "UTC", new Date())).toThrow(/Invalid schedule time/);
  });

  it("throws on an invalid timezone", () => {
    expect(() => nextRunAfter("08:00", "Not/AZone", new Date())).toThrow(
      /Invalid timezone/,
    );
  });
});

describe("formatWallClock", () => {
  it("formats a wall-clock label in the given zone", () => {
    expect(formatWallClock(new Date("2026-06-01T07:00:00.000Z"), "Europe/London")).toBe(
      "2026-06-01 08:00",
    );
    expect(formatWallClock(new Date("2026-01-05T09:05:00.000Z"), "UTC")).toBe(
      "2026-01-05 09:05",
    );
  });
});

describe("formatRelative", () => {
  it("describes a future instant in compact units", () => {
    const target = new Date("2026-06-01T09:12:00.000Z");
    const from = new Date("2026-06-01T00:00:00.000Z");
    expect(formatRelative(target, from)).toBe("in 9h 12m");
  });

  it("combines days, hours and minutes", () => {
    const target = new Date("2026-06-02T09:12:00.000Z");
    const from = new Date("2026-06-01T06:07:00.000Z");
    expect(formatRelative(target, from)).toBe("in 1d 3h 5m");
  });

  it("reports due work for a past or identical instant", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(formatRelative(new Date("2026-05-31T00:00:00.000Z"), now)).toBe("due now");
    expect(formatRelative(now, now)).toBe("due now");
  });
});