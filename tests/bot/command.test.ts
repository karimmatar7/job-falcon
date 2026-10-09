import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/bot/command.js";

describe("parseCommand", () => {
  it("parses a simple command", () => {
    expect(parseCommand("/start")).toEqual({ name: "start", args: [] });
  });

  it("parses a command with arguments", () => {
    expect(parseCommand("/search python developer london")).toEqual({
      name: "search",
      args: ["python", "developer", "london"],
    });
  });

  it("strips the bot suffix from a targeted command", () => {
    expect(parseCommand("/help@JobScoutBot")).toEqual({ name: "help", args: [] });
  });

  it("lowercases the command name", () => {
    expect(parseCommand("/StAtUs")).toEqual({ name: "status", args: [] });
  });

  it("trims surrounding and repeated whitespace", () => {
    expect(parseCommand("  /search   remote   uk  ")).toEqual({
      name: "search",
      args: ["remote", "uk"],
    });
  });

  it("returns null for non-command text", () => {
    expect(parseCommand("hello there")).toBeNull();
  });

  it("returns null for an empty or whitespace-only message", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
  });

  it("returns null when text is missing", () => {
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });

  it("returns null for a bare slash", () => {
    expect(parseCommand("/")).toBeNull();
  });

  it("rejects command names with invalid characters", () => {
    expect(parseCommand("/bad-name!")).toBeNull();
  });
});
