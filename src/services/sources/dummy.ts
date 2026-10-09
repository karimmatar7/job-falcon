import type { JobSource, SourceQuery } from './base.js';
import type { Vacancy } from '../../models/vacancy.js';
import { classifySponsorship } from '../sponsorship.js';

export class DummySource implements JobSource {
  readonly name = 'dummy';
  readonly enabled = false;

  async search(_query: SourceQuery): Promise<Vacancy[]> {
    return [];
  }
}
