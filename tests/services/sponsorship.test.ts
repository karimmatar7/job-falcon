import { describe, expect, it } from "vitest";
import {
  classifySponsorship,
  deriveEvidenceState,
  evidenceStateLabel,
  explainEvidence,
} from "../../src/services/sponsorship.js";

const base = {
  title: "Software Developer",
  employer: "Acme Ltd",
  sourceUrl: "https://example.com/jobs/1",
};

describe("classifySponsorship", () => {
  it("confirms sponsorship from explicit vacancy wording", () => {
    const result = classifySponsorship({
      ...base,
      description: "We will sponsor a Skilled Worker visa for the right candidate.",
    });

    expect(result.status).toBe("confirmed");
    expect(result.evidence).toContain("will sponsor");
    expect(result.evidence).toContain(base.sourceUrl);
  });

  it("preserves the exact containing sentence as evidence", () => {
    const result = classifySponsorship({
      ...base,
      description: "Great benefits. We are able to sponsor a work visa. Apply now.",
    });

    expect(result.status).toBe("confirmed");
    expect(result.evidence).toContain('"We are able to sponsor a work visa."');
  });

  it("does not confirm sponsorship from an employer licence alone", () => {
    const result = classifySponsorship({
      ...base,
      description: "We hold a sponsor licence and were recently audited.",
    });

    expect(result.status).toBe("unclear");
    expect(result.employerLicenceStatus).toBe("yes");
    expect(result.status).not.toBe("confirmed");
  });

  it("marks explicit refusals as not offered", () => {
    const result = classifySponsorship({
      ...base,
      description: "Unfortunately we are unable to sponsor this role.",
    });

    expect(result.status).toBe("not_offered");
  });

  it("treats an explicit visa-assistance refusal as not offered", () => {
    const result = classifySponsorship({
      ...base,
      description:
        "We do not provide visa assistance, and our cooperation model does not include those benefits.",
    });

    expect(result.status).toBe("not_offered");
    expect(result.evidence).toContain("do not provide visa assistance");
  });

  it("leaves ambiguous wording unclear", () => {
    const result = classifySponsorship({
      ...base,
      description: "This role is open to candidates eligible for the Skilled Worker route.",
    });

    expect(result.status).toBe("unclear");
  });

  it("reports silence when no description is provided", () => {
    const result = classifySponsorship({ ...base, description: "" });

    expect(result.status).toBe("unclear");
    expect(result.evidence).toContain("silence about sponsorship");
  });

  it("returns structured evidence with URL, snippet, reason and timestamp", () => {
    const result = classifySponsorship({
      ...base,
      description: "Great role. We will sponsor a Skilled Worker visa.",
    });

    expect(result.evidenceUrl).toBe(base.sourceUrl);
    expect(result.evidenceSnippet).toContain("will sponsor");
    expect(result.reason).toBe("explicit_vacancy_support");
    expect(Date.parse(result.lastVerifiedAt)).not.toBeNaN();
  });

  it("records an explicit refusal reason", () => {
    const result = classifySponsorship({
      ...base,
      description: "We are unable to sponsor this position.",
    });

    expect(result.reason).toBe("explicit_vacancy_refusal");
    expect(result.evidenceUrl).toBe(base.sourceUrl);
  });

  it("does not confirm when support and refusal conflict", () => {
    const result = classifySponsorship({
      ...base,
      description:
        "We will sponsor some roles. However, we are unable to sponsor this position.",
    });

    expect(result.status).not.toBe("confirmed");
    expect(result.status).toBe("not_offered");
  });
});

describe("deriveEvidenceState", () => {
  it("maps explicit vacancy support to vacancy_sponsorship_confirmed", () => {
    expect(
      deriveEvidenceState({ vacancySponsorshipStatus: "confirmed" }),
    ).toBe("vacancy_sponsorship_confirmed");
  });

  it("maps an authoritative employer verification to employer_sponsor_verified", () => {
    expect(
      deriveEvidenceState({
        vacancySponsorshipStatus: "unclear",
        employerSponsorshipVerified: true,
      }),
    ).toBe("employer_sponsor_verified");
  });

  it("never treats employer verification as vacancy confirmation", () => {
    expect(
      deriveEvidenceState({
        vacancySponsorshipStatus: "unclear",
        employerSponsorshipVerified: true,
      }),
    ).not.toBe("vacancy_sponsorship_confirmed");
  });

  it("maps silence to unconfirmed and refusal to sponsorship_unavailable", () => {
    expect(deriveEvidenceState({ vacancySponsorshipStatus: "unclear" })).toBe("unconfirmed");
    expect(deriveEvidenceState({ vacancySponsorshipStatus: "not_offered" })).toBe(
      "sponsorship_unavailable",
    );
  });
});

describe("evidenceStateLabel", () => {
  it("clearly distinguishes each state in plain text", () => {
    expect(evidenceStateLabel("vacancy_sponsorship_confirmed")).toContain("CONFIRMED");
    expect(evidenceStateLabel("employer_sponsor_verified")).toContain("NOT confirmed");
    expect(evidenceStateLabel("unconfirmed")).toContain("UNCONFIRMED");
    expect(evidenceStateLabel("sponsorship_unavailable")).toContain("NOT OFFERED");
  });
});

describe("explainEvidence", () => {
  it("explains confirmed and unavailable states from vacancy evidence", () => {
    expect(explainEvidence({ vacancySponsorshipStatus: "confirmed" })).toContain(
      "explicitly offers visa sponsorship",
    );
    expect(explainEvidence({ vacancySponsorshipStatus: "not_offered" })).toContain(
      "sponsorship is not offered",
    );
  });

  it("names the end employer for an agency-verified listing and still denies vacancy confirmation", () => {
    const text = explainEvidence({
      vacancySponsorshipStatus: "unclear",
      employerSponsorshipVerified: true,
      employerType: "recruiter",
      endEmployer: "Acme Financial Services",
    });

    expect(text).toContain("Acme Financial Services");
    expect(text).toContain("licensed sponsors");
    expect(text).toContain("does not confirm");
  });

  it("retains uncertainty for an agency whose end employer is unknown", () => {
    const text = explainEvidence({
      vacancySponsorshipStatus: "unclear",
      employerType: "recruiter",
    });

    expect(text.toLowerCase()).toContain("unconfirmed");
    expect(text.toLowerCase()).toContain("recruitment agency");
  });
});
