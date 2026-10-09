import { describe, expect, it } from "vitest";
import { buildWebhookUrl, resolveWebhookBaseUrl } from "../../src/config/webhook.js";

describe("resolveWebhookBaseUrl", () => {
  it("prefers an explicit TELEGRAM_WEBHOOK_URL", () => {
    expect(
      resolveWebhookBaseUrl({
        TELEGRAM_WEBHOOK_URL: "https://explicit.example.com",
        VERCEL_URL: "fallback.vercel.app",
      }),
    ).toBe("https://explicit.example.com");
  });

  it("falls back to PUBLIC_URL", () => {
    expect(resolveWebhookBaseUrl({ PUBLIC_URL: "https://public.example.com" })).toBe(
      "https://public.example.com",
    );
  });

  it("builds an https URL from VERCEL_URL", () => {
    expect(resolveWebhookBaseUrl({ VERCEL_URL: "job-scout.vercel.app" })).toBe(
      "https://job-scout.vercel.app",
    );
  });

  it("does not double-prefix an https VERCEL_URL", () => {
    expect(resolveWebhookBaseUrl({ VERCEL_URL: "https://job-scout.vercel.app" })).toBe(
      "https://job-scout.vercel.app",
    );
  });

  it("returns an empty string when nothing is configured", () => {
    expect(resolveWebhookBaseUrl({})).toBe("");
  });
});

describe("buildWebhookUrl", () => {
  it("appends the api/webhook route", () => {
    expect(buildWebhookUrl("https://job-scout.vercel.app")).toBe(
      "https://job-scout.vercel.app/api/webhook",
    );
  });
});
