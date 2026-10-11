import type { Vacancy } from "../models/vacancy.js";

export interface PaidTrainingAssessment {
  readonly isPaidTraining: boolean;
  /** Short, human-readable reason (present only when `isPaidTraining`). */
  readonly reason?: string;
}

/**
 * The applicant, not the employer, funds the programme. This is a strong,
 * unambiguous signal of a fee-charging advert rather than paid employment.
 */
const SELF_FUNDED_RE = /\bself[-\s]?fund(?:ed|ing|s)?\b/i;

/** Explicit applicant-payment language (the applicant owes money). */
const FEE_PATTERNS: readonly RegExp[] = [
  /\b(?:course|training|programme|program|tuition|enrolment|enrollment|delegate|placement|registration|admin(?:istration)?)\s+fees?\b/i,
  /\bfees?\s+(?:apply|applies|payable|required|are required|is required|incurred|charged)\b/i,
  /\b(?:pay|paying|payment of)\s+(?:a|an|the|your)?\s*(?:fee|fees|deposit|upfront|up-front|tuition)\b/i,
  /\bup[-\s]?front\s+(?:fee|fees|payment|cost|charge)\b/i,
  /\b(?:you|the\s+(?:candidate|applicant|trainee|delegate))\s+(?:will|must|would|need(?:s)?\s+to|are\s+required\s+to|have\s+to)\s+pay\b/i,
  /\b(?:applicant|candidate|trainee|delegate)\s+(?:pays|funds|self[-\s]?funds)\b/i,
  /\bfund(?:ed|ing)?\s+by\s+(?:yourself|the\s+(?:candidate|applicant|trainee|delegate)|you)\b/i,
];

/** Wording that places a listing in a training/placement context. */
const TRAINING_CONTEXT_RE =
  /\b(training|course|boot\s?camp|placement|programme|program|traineeship|upskill(?:ing)?|academy|cohort|workshop|masterclass)\b/i;

/**
 * The employer covers or waives fees, or the advert states there are none. The
 * employer-subject pattern is checked separately from a bare "fees ... covered"
 * so "fees are not covered" is not mistaken for an exemption.
 */
function feesCovered(text: string): boolean {
  const pattern =
    /\b(?:fees?|costs?|tuition)\b([^.]{0,40})\b(covered|reimbursed|refunded|waived|on\s+us)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const between = match[1] ?? "";
    if (!/\b(?:not|no|never)\b/i.test(between)) return true;
  }
  return /\b(?:we|the\s+company|the\s+employer|our\s+company)\b[^.]{0,30}\b(?:cover|pay|fund|reimburse)\b[^.]{0,30}\b(?:fees?|tuition|costs?)\b/i.test(
    text,
  );
}

const NO_FEES_RE =
  /\b(?:no|without|zero|nil|free\s+of)\b[^.]{0,25}\bfees?\b|\bfees?\s*[:\-]?\s*(?:none|nil|n\/a|not\s+applicable)\b|\bno\s+(?:course|training|programme|program|tuition|placement)\s+fees?\b/i;

/**
 * A deliberately conservative check for adverts that charge the applicant:
 * training courses, paid bootcamps and self-funded placement programmes.
 *
 * It requires positive evidence that the applicant pays (self-funding or an
 * explicit fee) **and** a training/placement context, and it backs off when the
 * listing says fees are covered or waived. A normal job that merely offers
 * training, or a paid placement that charges no fees, is never excluded.
 */
export function assessPaidTraining(
  vacancy: Pick<Vacancy, "title" | "description">,
): PaidTrainingAssessment {
  const text = `${vacancy.title} ${vacancy.description ?? ""}`.toLowerCase();
  if (text.trim().length === 0) return { isPaidTraining: false };

  const context = TRAINING_CONTEXT_RE.test(text);
  const selfFunded = SELF_FUNDED_RE.test(text);
  const chargesFees = FEE_PATTERNS.some((pattern) => pattern.test(text));
  if (!context || (!selfFunded && !chargesFees)) return { isPaidTraining: false };

  if (feesCovered(text) || NO_FEES_RE.test(text)) return { isPaidTraining: false };

  return {
    isPaidTraining: true,
    reason: selfFunded
      ? "lists a self-funded programme"
      : "charges applicant fees for training or a placement",
  };
}
