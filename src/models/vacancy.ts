import { z } from 'zod';

export const sponsorshipStatusSchema = z.enum(['confirmed', 'unclear', 'not_offered']);
export const employerLicenceStatusSchema = z.enum(['yes', 'no', 'unknown']);

/**
 * Four distinct evidence states, strongest to weakest. These are deliberately
 * separate from the raw vacancy-level `vacancySponsorshipStatus` so that
 * "employer is a licensed sponsor" is never confused with "this vacancy offers
 * sponsorship":
 *
 * - `vacancy_sponsorship_confirmed` explicit, vacancy-specific sponsorship evidence.
 * - `sponsorship_unavailable`       the vacancy explicitly states it cannot sponsor.
 * - `employer_sponsor_verified`     the relevant employer is on the official
 *                                   register, but THIS vacancy is unconfirmed.
 * - `unconfirmed`                   insufficient, ambiguous or unavailable evidence.
 */
export const evidenceStateSchema = z.enum([
  'vacancy_sponsorship_confirmed',
  'employer_sponsor_verified',
  'unconfirmed',
  'sponsorship_unavailable',
]);

/** Whether the named advertiser is the employer, an agency, or unknown. */
export const employerTypeSchema = z.enum(['employer', 'recruiter', 'unknown']);

/** Raw outcome of an official register lookup for an employer. */
export const sponsorRegisterStatusSchema = z.enum(['verified', 'not_found', 'unavailable']);

/**
 * Display-facing employer-register outcome, stored independently of
 * `vacancySponsorshipStatus`. A licensed employer never makes a vacancy
 * confirmed; `not_found` never means "unlicensed"; and `unavailable` never
 * implies a negative result. `not_checked` records that no lookup was possible
 * or appropriate (for example a recruitment agency whose client is unnamed).
 */
export const employerRegisterStatusSchema = z.enum([
  'verified',
  'not_found',
  'unavailable',
  'not_checked',
]);

export const locationEligibilitySchema = z.enum(['eligible', 'possibly', 'ineligible']);

export const vacancySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  employer: z.string().min(1),
  location: z.string().min(1),
  description: z.string().optional(),
  summary: z.string().optional(),
  source: z.string().min(1),
  sourceUrl: z.string().url(),
  /**
   * Direct link to this specific listing/application, when the source provided
   * a usable one. Optional on purpose: a missing or invalid job-specific URL is
   * never silently replaced with a source homepage, so an absent value simply
   * means the application link is unavailable (see `applicationUrlNote`).
   */
  applicationUrl: z.string().url().optional(),
  /** Why no direct application URL is available. Set only when the link is not usable. */
  applicationUrlNote: z.string().optional(),
  datePosted: z.string().optional(),
  salary: z.string().optional(),
  experienceLevel: z.string().optional(),
  vacancySponsorshipStatus: sponsorshipStatusSchema,
  sponsorshipEvidence: z.string().min(1),
  /** Official URL the sponsorship evidence was read from. */
  sponsorshipEvidenceUrl: z.string().url().optional(),
  /** Exact snippet backing the sponsorship classification. */
  sponsorshipEvidenceSnippet: z.string().optional(),
  /** Machine-readable reason for the classification. */
  sponsorshipEvidenceReason: z.string().optional(),
  employerSponsorLicence: employerLicenceStatusSchema,
  employerLicenceEvidence: z.string().min(1),
  /** True only when an authoritative sponsor register verified the employer. */
  employerSponsorshipVerified: z.boolean().optional(),
  /** Whether the named advertiser is the employer or an agency. */
  employerType: employerTypeSchema.optional(),
  /** The hiring organisation, only when a listing explicitly names it. */
  endEmployer: z.string().optional(),
  /** The organisation actually checked against the register, when verified. */
  employerVerificationTarget: z.string().optional(),
  /** Raw outcome of the register lookup used for this vacancy. */
  sponsorRegisterStatus: sponsorRegisterStatusSchema.optional(),
  /** URL of the register snapshot the employer was checked against. */
  sponsorRegisterUrl: z.string().url().optional(),
  /** When the register lookup for this vacancy was performed. */
  sponsorRegisterCheckedAt: z.string().optional(),
  /** When the register snapshot was downloaded. */
  sponsorRegisterRetrievedAt: z.string().optional(),
  /** The register snapshot's own publication date, when known. */
  sponsorRegisterUpdatedAt: z.string().optional(),
  /**
   * Employer-register outcome for the checked target, or why it was not
   * checked. Kept separate from `vacancySponsorshipStatus` on purpose.
   */
  employerRegisterStatus: employerRegisterStatusSchema.optional(),
  /** Canonical, human-facing evidence state derived from the facts above. */
  evidenceState: evidenceStateSchema.optional(),
  lastVerifiedAt: z.string().min(1),
  /** Whether the listing appears open to UK-based candidates. */
  locationEligibility: locationEligibilitySchema.optional(),
  matchScore: z.number().min(0).max(100).optional(),
  matchExplanation: z.string().optional(),
  /** Why an unconfirmed alternative was included in the shortlist. */
  fallbackReason: z.string().optional(),
});

export type Vacancy = z.infer<typeof vacancySchema>;
export type SponsorshipStatus = z.infer<typeof sponsorshipStatusSchema>;
export type EmployerLicenceStatus = z.infer<typeof employerLicenceStatusSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type EmployerType = z.infer<typeof employerTypeSchema>;
export type SponsorRegisterStatus = z.infer<typeof sponsorRegisterStatusSchema>;
export type EmployerRegisterStatus = z.infer<typeof employerRegisterStatusSchema>;
export type LocationEligibility = z.infer<typeof locationEligibilitySchema>;
