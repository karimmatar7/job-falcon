import { ServiceNotImplementedError } from "./errors.js";

export interface VerificationResult {
  readonly verified: boolean;
  readonly reasons: readonly string[];
}

export interface VacancyVerificationService {
  verify(listing: { readonly id: string; readonly url: string }): Promise<VerificationResult>;
}

export class PlaceholderVacancyVerificationService implements VacancyVerificationService {
  async verify(_listing: { readonly id: string; readonly url: string }): Promise<VerificationResult> {
    throw new ServiceNotImplementedError("Vacancy verification");
  }
}
