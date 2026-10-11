import { describe, expect, it } from "vitest";
import type { Vacancy } from "../../src/models/vacancy.js";
import {
  assessLocationEligibility,
  computeMatchScore,
  explainMatch,
  extractRequiredYears,
} from "../../src/services/relevanceScoring.js";

function vacancy(overrides: Partial<Vacancy> = {}): Vacancy {
  return {
    id: "job-1",
    title: "Software Developer",
    employer: "Acme Ltd",
    location: "Sheffield",
    source: "test",
    sourceUrl: "https://example.com/jobs/1",
    applicationUrl: "https://example.com/apply/1",
    vacancySponsorshipStatus: "unclear",
    sponsorshipEvidence: "no evidence",
    employerSponsorLicence: "unknown",
    employerLicenceEvidence: "none",
    lastVerifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("assessLocationEligibility", () => {
  it("marks explicit UK listings eligible", () => {
    expect(assessLocationEligibility("United Kingdom")).toBe("eligible");
    expect(assessLocationEligibility("UK")).toBe("eligible");
    expect(assessLocationEligibility("London, UK")).toBe("eligible");
    expect(assessLocationEligibility("Remote, United Kingdom")).toBe("eligible");
    expect(assessLocationEligibility("Leeds, Yorkshire")).toBe("eligible");
  });

  it("treats a listing that names the UK *and* foreign locations as uncertain, not eligible", () => {
    expect(assessLocationEligibility("USA, UK, India")).toBe("possibly");
    expect(
      assessLocationEligibility(
        "USA, UK, India, Australia, Ireland, New Zealand, Philippines, Pakistan, Singapore, Mexico",
      ),
    ).toBe("possibly");
    expect(assessLocationEligibility("United Kingdom and USA")).toBe("possibly");
  });

  it("treats worldwide/remote/Europe wording as possible, not certain", () => {
    expect(assessLocationEligibility("Worldwide")).toBe("possibly");
    expect(assessLocationEligibility("Remote")).toBe("possibly");
    expect(assessLocationEligibility("Europe, USA, Canada")).toBe("possibly");
  });

  it("marks locations that exclude the UK as ineligible", () => {
    expect(assessLocationEligibility("USA")).toBe("ineligible");
    expect(assessLocationEligibility("USA, Canada, Argentina, Mexico, Peru")).toBe("ineligible");
    expect(assessLocationEligibility("France, Japan, Turkey, Vietnam")).toBe("ineligible");
    expect(assessLocationEligibility("New York")).toBe("ineligible");
    expect(assessLocationEligibility("Berlin, Germany")).toBe("ineligible");
  });

  it("keeps specific British place names eligible (UK-only sources like Adzuna gb)", () => {
    expect(assessLocationEligibility("Liverpool, Merseyside")).toBe("eligible");
    expect(assessLocationEligibility("Maritime Quarter, Swansea")).toBe("eligible");
    expect(assessLocationEligibility("Newtownabbey, County Antrim")).toBe("eligible");
    expect(assessLocationEligibility("Heeley, Sheffield")).toBe("eligible");
    expect(assessLocationEligibility("Sompting, Lancing")).toBe("eligible");
    expect(assessLocationEligibility("Hanley, Stoke-On-Trent")).toBe("eligible");
  });
});

describe("extractRequiredYears", () => {
  it("finds the highest required years", () => {
    expect(extractRequiredYears("3+ years of experience; 5 years preferred")).toBe(5);
  });

  it("returns null when no requirement is stated", () => {
    expect(extractRequiredYears("No formal experience required")).toBeNull();
  });
});

describe("computeMatchScore", () => {
  it("scores entry-level development roles above senior equivalents", () => {
    const junior = computeMatchScore(vacancy({ title: "Junior React Developer" }));
    const senior = computeMatchScore(vacancy({ title: "Senior React Developer" }));
    expect(junior).toBeGreaterThan(senior);
  });

  it("heavily penalises principal/staff/architect roles", () => {
    const engineer = computeMatchScore(vacancy({ title: "Backend Engineer" }));
    const principal = computeMatchScore(vacancy({ title: "Principal Backend Architect" }));
    expect(principal).toBeLessThan(engineer);
    expect(principal).toBeLessThan(20);
  });

  it("penalises non-development roles", () => {
    const dev = computeMatchScore(vacancy({ title: "Frontend Developer" }));
    const sales = computeMatchScore(vacancy({ title: "Inside Sales Contractor" }));
    expect(sales).toBeLessThan(dev);
    expect(sales).toBeLessThan(25);
  });

  it("applies an extra penalty to senior roles that also demand 4+ years", () => {
    const senior = computeMatchScore(vacancy({ title: "Senior React Developer" }));
    const seniorExperienced = computeMatchScore(
      vacancy({
        title: "Senior React Developer",
        description: "Ideal candidates bring 5+ years of professional experience.",
      }),
    );
    expect(seniorExperienced).toBeLessThan(senior);
  });

  it("penalises roles demanding several years of experience", () => {
    const base = computeMatchScore(vacancy({ title: "React Developer" }));
    const experienced = computeMatchScore(
      vacancy({
        title: "React Developer",
        description: "You will need 5+ years of professional experience.",
      }),
    );
    expect(experienced).toBeLessThan(base);
  });

  it("rewards UK-eligible locations more than non-UK remote roles", () => {
    const uk = computeMatchScore(vacancy({ title: "React Developer", location: "UK" }));
    const us = computeMatchScore(vacancy({ title: "React Developer", location: "USA" }));
    expect(uk).toBeGreaterThan(us);
  });

  it("does not award the full UK-location bonus to mixed UK/foreign listings", () => {
    const uk = computeMatchScore(vacancy({ title: "React Developer", location: "UK" }));
    const mixed = computeMatchScore(
      vacancy({ title: "React Developer", location: "USA, UK, India, Australia, Singapore, Mexico" }),
    );
    const us = computeMatchScore(vacancy({ title: "React Developer", location: "USA" }));
    expect(mixed).toBeLessThan(uk);
    expect(mixed).toBeGreaterThan(us);
  });

  it("keeps scores within 0-100", () => {
    const score = computeMatchScore(vacancy({ title: "Junior Graduate React Developer", location: "Sheffield" }));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("mandatory vs incidental skills", () => {
  it("does not let an incidental React mention outweigh mandatory C#/.NET requirements", () => {
    const incidentalReact = vacancy({
      title: "Software Developer",
      description:
        "You will use React on some pages. Essential: commercial experience with C# and .NET, SQL Server and REST APIs.",
    });
    const reactRole = vacancy({
      title: "React Developer",
      description: "You will build interfaces with React, JavaScript and TypeScript.",
    });

    expect(computeMatchScore(incidentalReact)).toBeLessThan(25);
    expect(computeMatchScore(incidentalReact)).toBeLessThan(computeMatchScore(reactRole));
  });

  it("does not penalise an incidental mention of an unfamiliar technology", () => {
    const base = computeMatchScore(
      vacancy({
        title: "React Developer",
        description: "You will build React and TypeScript applications.",
      }),
    );
    const withMention = computeMatchScore(
      vacancy({
        title: "React Developer",
        description:
          "You will build React and TypeScript applications. You may occasionally integrate with a C# service.",
      }),
    );

    expect(withMention).toBeGreaterThanOrEqual(25);
    expect(withMention).toBeGreaterThanOrEqual(base - 5);
  });

  it("still rewards a role that requires a core skill alongside other technologies", () => {
    const score = computeMatchScore(
      vacancy({
        title: "Software Developer",
        description: "Essential: strong JavaScript and TypeScript. Desirable: C#.",
      }),
    );

    expect(score).toBeGreaterThanOrEqual(25);
  });
});

describe("required vs incidental skill weighting", () => {
  it("weights required skills above incidental mentions", () => {
    const required = computeMatchScore(
      vacancy({
        title: "Software Developer",
        description: "Required: strong React experience.",
      }),
    );
    const incidental = computeMatchScore(
      vacancy({
        title: "Software Developer",
        description: "You will work on web applications; the team uses React.",
      }),
    );

    expect(required).toBeGreaterThan(incidental);
    expect(incidental).toBeGreaterThanOrEqual(25);
  });

  it("penalises a foreign-dominant mandatory stack even when a core skill is a co-requirement", () => {
    const mixed = vacancy({
      title: "Software Developer",
      description:
        "Essential: commercial experience with C# and .NET, SQL Server and React.",
    });
    const junior = vacancy({
      title: "Junior React Developer",
      description: "Essential: React, JavaScript and TypeScript.",
    });

    const mixedScore = computeMatchScore(mixed);
    expect(mixedScore).toBeLessThan(25);
    expect(mixedScore).toBeLessThan(computeMatchScore(junior));
  });

  it("does not penalise a mandatory stack where core skills dominate", () => {
    const score = computeMatchScore(
      vacancy({
        title: "Software Developer",
        description: "Essential: React, TypeScript and some C# on the backend.",
      }),
    );

    expect(score).toBeGreaterThanOrEqual(25);
  });

  it("keeps QA/testing roles eligible even when the mandatory tooling is not a core skill", () => {
    const description = "Required: automation testing using C# and Selenium WebDriver.";
    const qa = computeMatchScore(vacancy({ title: "Test Automation Engineer", description }));
    const dev = computeMatchScore(vacancy({ title: "Software Developer", description }));

    expect(qa).toBeGreaterThanOrEqual(25);
    expect(qa).toBeGreaterThan(dev);
    expect(dev).toBeLessThan(25);
  });

  it("does not require every technology in a listing to match the profile", () => {
    const score = computeMatchScore(
      vacancy({
        title: "React Developer",
        description: "Required: React and TypeScript. You will also work with PHP and Ruby occasionally.",
      }),
    );

    expect(score).toBeGreaterThanOrEqual(40);
  });
});

describe("no-skill-match penalty", () => {
  it("keeps a described role with no profile skill match below the alternative bar", () => {
    const v = vacancy({
      title: "Software Development Engineer",
      description:
        "Work on our logistics platform used by thousands of retailers. You will build features, fix defects and collaborate across the team.",
    });

    const score = computeMatchScore(v);

    expect(score).toBeLessThan(25);
    expect(explainMatch(v, score)).toContain("no profile skill match");
  });

  it("gives a title-only listing without a description the benefit of the doubt", () => {
    const score = computeMatchScore(vacancy({ title: "Software Development Engineer" }));

    expect(score).toBeGreaterThanOrEqual(25);
  });

  it("does not penalise described entry-level roles with no exact skill match", () => {
    const score = computeMatchScore(
      vacancy({
        title: "Graduate Software Developer",
        description:
          "Full training provided and no experience necessary. We invest in your development throughout the programme.",
      }),
    );

    expect(score).toBeGreaterThanOrEqual(25);
  });

  it("leaves confirmed sponsorship scores untouched by the no-skill penalty", () => {
    const v = vacancy({
      title: "Software Developer",
      description:
        "We provide a structured training programme and will sponsor a Skilled Worker visa. All course fees are covered by us.",
      vacancySponsorshipStatus: "confirmed",
    });

    expect(computeMatchScore(v)).toBe(35);
  });
});

describe("senior title scoring", () => {
  it("keeps clearly senior titles out of strong-match territory", () => {
    const lead = computeMatchScore(vacancy({ title: "Lead Full Stack Software Developer" }));
    const junior = computeMatchScore(vacancy({ title: "Junior React Developer" }));

    expect(lead).toBeLessThan(25);
    expect(lead).toBeLessThan(junior);
  });

  it("does not score false-positive seniority spellings as senior", () => {
    const specialist = computeMatchScore(vacancy({ title: "Lead Generation Specialist" }));
    const staffing = computeMatchScore(vacancy({ title: "Staffing Consultant" }));
    const senior = computeMatchScore(vacancy({ title: "Senior Software Developer" }));

    expect(specialist).toBeGreaterThan(0);
    expect(staffing).toBeGreaterThan(0);
    expect(senior).toBeLessThan(specialist);
  });
});

describe("explainMatch", () => {
  it("explains penalties as well as positives", () => {
    const v = vacancy({ title: "Senior React Developer" });
    const explanation = explainMatch(v, computeMatchScore(v));
    expect(explanation).toContain("senior");
    expect(explanation).toContain("Score");
  });
});
