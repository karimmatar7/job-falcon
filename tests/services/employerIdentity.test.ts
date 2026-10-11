import { describe, expect, it } from "vitest";
import {
  detectAdvertiserRole,
  employerVerificationTarget,
  resolveEmployerIdentity,
} from "../../src/services/employerIdentity.js";

describe("detectAdvertiserRole", () => {
  it("classifies an in-house advertiser as the employer", () => {
    expect(
      detectAdvertiserRole("Northwind Software", "We are hiring developers."),
    ).toBe("employer");
  });

  it("detects an agency from its own name", () => {
    expect(detectAdvertiserRole("Blue Talent Recruitment", "Great role.")).toBe("recruiter");
    expect(detectAdvertiserRole("Manpower UK", "Great role.")).toBe("recruiter");
  });

  it("detects an agency from client wording even when the name looks in-house", () => {
    expect(
      detectAdvertiserRole("Fruition Group", "We are recruiting for our client."),
    ).toBe("recruiter");
  });

  it("treats an empty advertiser name as unknown", () => {
    expect(detectAdvertiserRole("   ", "Some text")).toBe("unknown");
  });
});

describe("resolveEmployerIdentity", () => {
  it("returns only the advertiser for a direct employer", () => {
    const identity = resolveEmployerIdentity({
      employer: "Northwind Software",
      description: "We are hiring developers.",
    });

    expect(identity.advertiserRole).toBe("employer");
    expect(identity.endEmployer).toBeUndefined();
  });

  it("extracts a named end employer from an agency listing", () => {
    const identity = resolveEmployerIdentity({
      employer: "Blue Talent Recruitment",
      description: "Our client Acme Financial Services is hiring a developer.",
    });

    expect(identity.advertiserRole).toBe("recruiter");
    expect(identity.endEmployer).toBe("Acme Financial Services");
  });

  it("does not invent an end employer from a vague phrase", () => {
    const identity = resolveEmployerIdentity({
      employer: "Blue Talent Recruitment",
      description: "Our client, a leading fintech, is hiring.",
    });

    expect(identity.advertiserRole).toBe("recruiter");
    expect(identity.endEmployer).toBeUndefined();
  });

  it("never returns the advertiser as its own end employer", () => {
    const identity = resolveEmployerIdentity({
      employer: "Blue Talent Recruitment",
      description: "We are recruiting for Blue Talent Recruitment.",
    });

    expect(identity.endEmployer).toBeUndefined();
  });
});

describe("employerVerificationTarget", () => {
  it("targets the advertiser when it is the employer", () => {
    expect(
      employerVerificationTarget({
        advertiser: "Northwind Software",
        advertiserRole: "employer",
      }),
    ).toBe("Northwind Software");
  });

  it("targets the named client for an agency", () => {
    expect(
      employerVerificationTarget({
        advertiser: "Blue Talent Recruitment",
        advertiserRole: "recruiter",
        endEmployer: "Acme Financial Services",
      }),
    ).toBe("Acme Financial Services");
  });

  it("returns undefined for an agency with no named client, never the agency itself", () => {
    expect(
      employerVerificationTarget({
        advertiser: "Blue Talent Recruitment",
        advertiserRole: "recruiter",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for an unknown advertiser", () => {
    expect(employerVerificationTarget({ advertiser: "", advertiserRole: "unknown" })).toBeUndefined();
  });
});
