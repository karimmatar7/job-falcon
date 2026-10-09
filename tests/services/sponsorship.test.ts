import { describe, expect, it } from "vitest";
import { classifySponsorship } from "../../src/services/sponsorship.js";

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
});
