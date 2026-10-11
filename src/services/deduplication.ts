import type { Vacancy } from '../models/vacancy.js';

export interface DedupResult {
  readonly kept: Vacancy[];
  readonly duplicates: { original: Vacancy; duplicate: Vacancy }[];
}

function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

export function isTppExcluded(vacancy: Vacancy): boolean {
  const titleNorm = normaliseText(vacancy.title);
  const employerNorm = normaliseText(vacancy.employer);
  const locationNorm = vacancy.location.toLowerCase();

  const isTpp = employerNorm.includes('tpp');
  const isGraduateDev = titleNorm.includes('graduatesoftwaredeveloper') || titleNorm.includes('graduatedeveloper') || titleNorm.includes('graduatesoftware');
  const isLeeds = locationNorm.includes('leeds');

  if (isTpp && isGraduateDev && isLeeds) return true;
  if (employerNorm === 'tpp' && isGraduateDev && isLeeds) return true;
  return false;
}

/**
 * Identity of a listing for cross-source de-duplication. Location is part of
 * the key on purpose: the same employer+title advertised in several places
 * (e.g. one placement programme across nine UK cities) is a set of distinct
 * adverts, not a repeat. Genuine reposts still share employer, title *and*
 * location, and true repeats of the same advert share a URL or id.
 */
function identityKey(v: Vacancy): string {
  return `et:${normaliseText(v.employer)}||${normaliseText(v.title)}||${normaliseText(v.location)}`;
}

/** Namespaced so URL, identity and id keys can never collide in one set. */
function urlKey(v: Vacancy): string {
  return `url:${normaliseText(v.applicationUrl || v.sourceUrl)}`;
}

export function findDuplicates(vacancies: Vacancy[]): DedupResult {
  const kept: Vacancy[] = [];
  const duplicates: Array<{ original: Vacancy; duplicate: Vacancy }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < vacancies.length; i++) {
    const v = vacancies[i] as Vacancy;

    const byUrl = urlKey(v);
    if (seen.has(byUrl)) {
      const orig = kept.find((k) => urlKey(k) === byUrl);
      if (orig) duplicates.push({ original: orig, duplicate: v });
      continue;
    }
    seen.add(byUrl);

    const byIdentity = identityKey(v);
    if (seen.has(byIdentity)) {
      const orig = kept.find((k) => identityKey(k) === byIdentity);
      if (orig) duplicates.push({ original: orig, duplicate: v });
      continue;
    }
    seen.add(byIdentity);

    if (v.id) {
      const byId = `id:${v.id}`;
      if (seen.has(byId)) {
        const orig = kept.find((k) => k.id === v.id);
        if (orig) duplicates.push({ original: orig, duplicate: v });
        continue;
      }
      seen.add(byId);
    }

    kept.push(v);
  }

  return { kept, duplicates };
}
