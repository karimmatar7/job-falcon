import { describe, expect, it } from "vitest";
import { assessPaidTraining } from "../../src/services/listingQuality.js";

function listing(title: string, description: string) {
  return { title, description };
}

describe("assessPaidTraining", () => {
  it("flags a self-funded placement programme that charges fees", () => {
    const result = assessPaidTraining(
      listing(
        "Software Developer Placement Programme - No experience needed",
        "This is a self-funded programme. Course fees apply and you will be required to pay a deposit.",
      ),
    );

    expect(result.isPaidTraining).toBe(true);
    expect(result.reason).toContain("self-funded");
  });

  it("flags a paid bootcamp that charges applicant fees", () => {
    const result = assessPaidTraining(
      listing("Full Stack Bootcamp", "A 12-week bootcamp. Programme fees are payable upfront."),
    );

    expect(result.isPaidTraining).toBe(true);
    expect(result.reason).toContain("fees");
  });

  it("flags an advert that requires the applicant to pay for the training", () => {
    const result = assessPaidTraining(
      listing(
        "Software Development Training Course",
        "During the course you will need to pay a fee of £250 per month.",
      ),
    );

    expect(result.isPaidTraining).toBe(true);
  });

  it("does not flag a legitimate job that offers training", () => {
    const result = assessPaidTraining(
      listing(
        "Graduate Software Developer",
        "Full training provided and no experience necessary. We invest in your development.",
      ),
    );

    expect(result.isPaidTraining).toBe(false);
  });

  it("does not flag a job where the employer covers the course fees", () => {
    const result = assessPaidTraining(
      listing(
        "Junior Developer",
        "We provide a training course, and all course fees are covered by us.",
      ),
    );

    expect(result.isPaidTraining).toBe(false);
  });

  it("does not flag a paid placement that charges no fees", () => {
    const result = assessPaidTraining(
      listing(
        "Industrial Placement Software Engineer",
        "A paid 12-month placement programme. No fees apply to applicants.",
      ),
    );

    expect(result.isPaidTraining).toBe(false);
  });

  it("does not flag fee wording with no training or placement context", () => {
    const result = assessPaidTraining(
      listing(
        "Senior Software Developer",
        "Standard professional membership fees are payable annually.",
      ),
    );

    expect(result.isPaidTraining).toBe(false);
  });

  it("does not flag a job that mentions a bootcamp experience as a benefit", () => {
    const result = assessPaidTraining(
      listing(
        "Frontend Engineer",
        "A background from any bootcamp is welcome, but not required. We offer free in-house training.",
      ),
    );

    expect(result.isPaidTraining).toBe(false);
  });
});