import { ServiceNotImplementedError } from "./errors.js";
import type { Vacancy } from "../models/vacancy.js";

export interface DuplicateMatch {
  readonly listingId: string;
  readonly duplicateOf: string;
  readonly confidence: number;
}

export interface DuplicateDetectionService {
  findDuplicates(listings: readonly Vacancy[]): Promise<readonly DuplicateMatch[]>;
}

export class PlaceholderDuplicateDetectionService implements DuplicateDetectionService {
  async findDuplicates(_listings: readonly Vacancy[]): Promise<readonly DuplicateMatch[]> {
    throw new ServiceNotImplementedError("Duplicate detection");
  }
}
