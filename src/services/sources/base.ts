import type { Vacancy } from '../../models/vacancy.js';

export interface JobSource {
  readonly name: string;
  readonly enabled: boolean;
  search(query: SourceQuery): Promise<Vacancy[]>;
}

export interface SourceQuery {
  readonly limit?: number;
  readonly keywords?: string[];
  readonly location?: string;
}

export class SourceError extends Error {
  constructor(message: string, readonly source: string) {
    super(message);
    this.name = 'SourceError';
  }
}
