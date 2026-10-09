import { z } from 'zod';

export const sponsorshipStatusSchema = z.enum(['confirmed', 'unclear', 'not_offered']);
export const employerLicenceStatusSchema = z.enum(['yes', 'no', 'unknown']);

export const vacancySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  employer: z.string().min(1),
  location: z.string().min(1),
  description: z.string().optional(),
  summary: z.string().optional(),
  source: z.string().min(1),
  sourceUrl: z.string().url(),
  applicationUrl: z.string().url(),
  datePosted: z.string().optional(),
  salary: z.string().optional(),
  experienceLevel: z.string().optional(),
  vacancySponsorshipStatus: sponsorshipStatusSchema,
  sponsorshipEvidence: z.string().min(1),
  employerSponsorLicence: employerLicenceStatusSchema,
  employerLicenceEvidence: z.string().min(1),
  lastVerifiedAt: z.string().min(1),
  matchScore: z.number().min(0).max(100).optional(),
  matchExplanation: z.string().optional(),
});

export type Vacancy = z.infer<typeof vacancySchema>;
export type SponsorshipStatus = z.infer<typeof sponsorshipStatusSchema>;
export type EmployerLicenceStatus = z.infer<typeof employerLicenceStatusSchema>;
