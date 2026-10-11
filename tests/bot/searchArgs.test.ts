import { describe, expect, it } from "vitest";
import { MAX_SEARCH_LIMIT, parseSearchArgs } from "../../src/bot/searchArgs.js";

describe("parseSearchArgs", () => {
  it("defaults when there are no arguments", () => {
    expect(parseSearchArgs([])).toEqual({ ok: true, limit: 5, keywords: [] });
  });

  it("accepts a numeric limit on its own", () => {
    expect(parseSearchArgs(["5"])).toEqual({ ok: true, limit: 5, keywords: [] });
    expect(parseSearchArgs(["1"])).toEqual({ ok: true, limit: 1, keywords: [] });
  });

  it("clamps a numeric limit to the maximum", () => {
    expect(parseSearchArgs(["999"])).toEqual({
      ok: true,
      limit: MAX_SEARCH_LIMIT,
      keywords: [],
    });
  });

  it("accepts a signed positive limit", () => {
    expect(parseSearchArgs(["+7"])).toEqual({ ok: true, limit: 7, keywords: [] });
  });

  it("rejects zero and negative limits", () => {
    expect(parseSearchArgs(["0"]).ok).toBe(false);
    expect(parseSearchArgs(["-3"]).ok).toBe(false);
  });

  it("splits multi-word keywords and a trailing location", () => {
    expect(parseSearchArgs(["software", "developer", "leeds"])).toEqual({
      ok: true,
      limit: 5,
      keywords: ["software", "developer"],
      location: "leeds",
    });
  });

  it("supports single-word keywords and a location", () => {
    expect(parseSearchArgs(["javascript", "leeds"])).toEqual({
      ok: true,
      limit: 5,
      keywords: ["javascript"],
      location: "leeds",
    });
  });

  it("treats multi-word keywords as keywords when there is no location", () => {
    expect(parseSearchArgs(["software", "developer"])).toEqual({
      ok: true,
      limit: 5,
      keywords: ["software", "developer"],
    });
  });

  it("treats a lone known place as a location with default keywords", () => {
    expect(parseSearchArgs(["leeds"])).toEqual({
      ok: true,
      limit: 5,
      keywords: [],
      location: "leeds",
    });
  });

  it("recognises multi-word locations and preserves their case", () => {
    expect(parseSearchArgs(["Milton", "Keynes"])).toEqual({
      ok: true,
      limit: 5,
      keywords: [],
      location: "Milton Keynes",
    });
  });

  it("does not mistake ordinary words for a numeric limit", () => {
    expect(parseSearchArgs(["3d", "printing"])).toEqual({
      ok: true,
      limit: 5,
      keywords: ["3d", "printing"],
    });
    expect(parseSearchArgs(["remote", "developer"])).toEqual({
      ok: true,
      limit: 5,
      keywords: ["remote", "developer"],
    });
  });

  it("combines a limit with keywords and a location unambiguously", () => {
    expect(parseSearchArgs(["8", "software", "developer", "leeds"])).toEqual({
      ok: true,
      limit: 8,
      keywords: ["software", "developer"],
      location: "leeds",
    });
  });

  it("ignores empty tokens", () => {
    expect(parseSearchArgs(["", "javascript", ""])).toEqual({
      ok: true,
      limit: 5,
      keywords: ["javascript"],
    });
  });
});