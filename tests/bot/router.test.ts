import { describe, expect, it } from "vitest";
import { replyForText } from "../../src/bot/router.js";

describe("replyForText", () => {
  it("replies to an unknown command", () => {
    expect(replyForText("/unknown")).toContain("/unknown");
  });

  it("includes a help hint for unknown commands", () => {
    expect(replyForText("/nope")).toContain("/help");
  });

  it("ignores normal chatter", () => {
    expect(replyForText("just saying hello")).toBeNull();
  });

  it("ignores missing text", () => {
    expect(replyForText(undefined)).toBeNull();
  });

  it("ignores a bare slash with no command", () => {
    expect(replyForText("/")).toBeNull();
  });
});
