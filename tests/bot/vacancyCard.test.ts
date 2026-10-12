import { describe, expect, it } from "vitest";
import {
  employerRegisterLine,
  employerRegisterStatusOf,
  escapeMd,
  formatVacancy,
  groupFor,
  sponsorshipLabel,
  vacancyEvidenceState,
} from "../../src/bot/vacancyCard.js";
import { makeVacancy } from "../testKit.js";
import type { Vacancy } from "../../src/models/vacancy.js";

function alternative(overrides: Partial<Vacancy> = {}) {
  return makeVacancy({
    id: "alt-1",
    vacancySponsorshipStatus: "unclear",
    sponsorshipEvidence: "No explicit sponsorship support found.",
    employerSponsorLicence: "unknown",
    employerLicenceEvidence: "No licence mentioned.",
    ...overrides,
  });
}

describe("escapeMd", () => {
  it("escapes Telegram MarkdownV2 specials", () => {
    expect(escapeMd("a_b [x] (y) ~z #hashtag -plus +plus =eq |pipe {b} .dot !bang")).toBe(
      "a\\_b \\[x\\] \\(y\\) \\~z \\#hashtag \\-plus \\+plus \\=eq \\|pipe \\{b\\} \\.dot \\!bang",
    );
  });
  it("leaves plain text alone", () => {
    expect(escapeMd("Software Developer UK 2026")).toBe("Software Developer UK 2026");
  });
});

describe("groupFor", () => {
  it("classifies by vacancy sponsorship status", () => {
    expect(groupFor(makeVacancy())).toBe("confirmed");
    expect(groupFor(alternative())).toBe("alternative");
    expect(groupFor(makeVacancy({ vacancySponsorshipStatus: "not_offered" }))).toBe(
      "not_offered",
    );
  });
});

describe("sponsorshipLabel", () => {
  it("labels each evidence state distinctly", () => {
    expect(sponsorshipLabel(makeVacancy(), "confirmed")).toBe(
      "Sponsorship: CONFIRMED for this vacancy",
    );
    expect(sponsorshipLabel(alternative(), "alternative")).toBe(
      "Sponsorship: UNCONFIRMED - ask the employer",
    );
    expect(sponsorshipLabel(makeVacancy({ vacancySponsorshipStatus: "not_offered" }), "not_offered")).toBe(
      "Sponsorship: NOT OFFERED for this vacancy",
    );
  });

  it("labels a verified employer as unconfirmed for THIS vacancy", () => {
    const label = sponsorshipLabel(
      alternative({ employerSponsorshipVerified: true }),
      "alternative",
    );
    expect(label).toContain("LICENSED SPONSOR");
    expect(label).toContain("NOT confirmed");
  });
});

describe("employerRegisterStatusOf", () => {
  it("prefers the explicit register status", () => {
    const vacancy = makeVacancy({ employerRegisterStatus: "unavailable" });
    expect(employerRegisterStatusOf(vacancy)).toBe("unavailable");
  });

  it("falls back to the legacy verified flag", () => {
    const vacancy = makeVacancy({ employerSponsorshipVerified: true });
    expect(employerRegisterStatusOf(vacancy)).toBe("verified");
  });

  it("is undefined when no register outcome exists", () => {
    expect(employerRegisterStatusOf(makeVacancy())).toBeUndefined();
  });
});

describe("employerRegisterLine", () => {
  it("never implies register membership means vacancy sponsorship", () => {
    const line = employerRegisterLine(
      makeVacancy({ employerRegisterStatus: "verified", employerVerificationTarget: "Acme Ltd" }),
    );
    expect(line).toContain("LICENSED SPONSOR");
    expect(line).toContain('matched "Acme Ltd"');
  });

  it("reports not_found without claiming the employer is unlicensed", () => {
    const line = employerRegisterLine(makeVacancy({ employerRegisterStatus: "not_found" }));
    expect(line).toContain("no exact match");
    expect(line).toContain("does NOT prove the employer is unlicensed");
  });

  it("reports an unavailable register as inconclusive", () => {
    const line = employerRegisterLine(makeVacancy({ employerRegisterStatus: "unavailable" }));
    expect(line).toContain("could not be checked");
    expect(line).toContain("no conclusion");
  });

  it("explains not_checked for recruiter listings", () => {
    const line = employerRegisterLine(
      makeVacancy({ employerRegisterStatus: "not_checked", employerType: "recruiter" }),
    );
    expect(line).toContain("recruitment agency");
  });

  it("returns null when no register outcome is stored", () => {
    expect(employerRegisterLine(makeVacancy())).toBeNull();
  });
});

describe("formatVacancy", () => {
  it("renders a confirmed vacancy with its evidence", () => {
    const card = formatVacancy(makeVacancy(), "confirmed");
    expect(card).toContain("*Graduate Software Developer*");
    expect(card).toContain("Employer: Acme Ltd");
    expect(card).toContain("Location: Sheffield");
    expect(card).toContain("Sponsorship: CONFIRMED for this vacancy");
    expect(card).toContain("Evidence: We will sponsor a Skilled Worker visa");
    expect(card).toContain("Apply: https://example\\.com/apply/1");
    expect(card).toContain("Source: test\\-source");
  });

  it("shows UK eligibility and salary when present", () => {
    const card = formatVacancy(
      makeVacancy({ locationEligibility: "eligible", salary: "£30,000 - £35,000" }),
      "confirmed",
    );
    expect(card).toContain("UK eligibility: eligible");
    expect(card).toContain("Salary");
  });

  it("renders an alternative as unconfirmed with an honest note", () => {
    const card = formatVacancy(
      alternative({ fallbackReason: "matches the query keywords", matchScore: 61 }),
      "alternative",
    );
    expect(card).toContain("Sponsorship: UNCONFIRMED");
    expect(card).toContain("Why shown: matches the query keywords");
    expect(card).toContain("Match: 61/100");
    expect(card).toContain("this listing contains no sponsorship evidence");
    expect(card).not.toContain("CONFIRMED for this vacancy");
  });

  it("keeps a licensed employer distinct from a confirmed vacancy", () => {
    const card = formatVacancy(
      alternative({
        employerRegisterStatus: "verified",
        employerSponsorshipVerified: true,
        employerVerificationTarget: "Acme Ltd",
      }),
      "alternative",
    );
    expect(card).toContain("LICENSED SPONSOR");
    expect(card).toContain(
      "the vacancy itself does not confirm sponsorship for this role",
    );
    expect(card).not.toContain("CONFIRMED for this vacancy");
  });

  it("renders a not_offered vacancy as unavailable", () => {
    const card = formatVacancy(
      makeVacancy({ vacancySponsorshipStatus: "not_offered" }),
      "not_offered",
    );
    expect(card).toContain("Sponsorship: NOT OFFERED for this vacancy");
    expect(card).not.toContain("CONFIRMED for this vacancy");
  });
});

describe("vacancyEvidenceState", () => {
  it("prefers a stored evidence state", () => {
    const vacancy = makeVacancy({ evidenceState: "unconfirmed" });
    expect(vacancyEvidenceState(vacancy)).toBe("unconfirmed");
  });

  it("derives one when absent", () => {
    expect(vacancyEvidenceState(makeVacancy())).toBe("vacancy_sponsorship_confirmed");
    expect(vacancyEvidenceState(alternative())).toBe("unconfirmed");
  });
});