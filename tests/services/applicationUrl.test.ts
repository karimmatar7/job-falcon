import { describe, expect, it } from "vitest";
import { validateApplicationUrl } from "../../src/services/applicationUrl.js";

describe("validateApplicationUrl", () => {
  it("accepts a direct listing URL", () => {
    const result = validateApplicationUrl("https://www.adzuna.co.uk/jobs/details/12345");
    expect(result.status).toBe("direct");
    expect(result.url).toBe("https://www.adzuna.co.uk/jobs/details/12345");
  });

  it("rejects a bare site homepage as not job-specific", () => {
    const result = validateApplicationUrl("https://www.adzuna.co.uk/");
    expect(result.status).toBe("unavailable");
    expect(result.url).toBeUndefined();
    expect(result.note).toContain("homepage");
  });

  it("treats /index.html as a homepage", () => {
    expect(validateApplicationUrl("https://example.com/index.html").status).toBe("unavailable");
  });

  it("does not treat a listing path as a homepage", () => {
    expect(validateApplicationUrl("https://example.com/jobs/").status).toBe("direct");
    expect(validateApplicationUrl("https://example.com/jobs/details/42").status).toBe("direct");
  });

  it("reports a missing URL as unavailable", () => {
    expect(validateApplicationUrl(undefined).status).toBe("unavailable");
    expect(validateApplicationUrl("").status).toBe("unavailable");
    expect(validateApplicationUrl("   ").status).toBe("unavailable");
  });

  it("reports a malformed URL as invalid", () => {
    expect(validateApplicationUrl("not a url").status).toBe("invalid");
    expect(validateApplicationUrl("file:///tmp/job").status).toBe("invalid");
    expect(validateApplicationUrl("ftp://example.com/job").status).toBe("invalid");
  });

  it("never suggests a replacement URL for an unusable link", () => {
    const homepage = validateApplicationUrl("https://www.adzuna.co.uk");
    expect(homepage.status).toBe("unavailable");
    expect(homepage.url).toBeUndefined();
  });
});