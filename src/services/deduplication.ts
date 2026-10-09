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

export function findDuplicates(vacancies: Vacancy[]): DedupResult {
  const kept: Vacancy[] = [];
  const duplicates: Array<{ original: Vacancy; duplicate: Vacancy }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < vacancies.length; i++) {
    const v = vacancies[i] as Vacancy;
    const urlKey = normaliseText(v.applicationUrl || v.sourceUrl);
    if (seen.has(urlKey)) {
      const orig = kept.find((k) => normaliseText(k.applicationUrl || k.sourceUrl) === urlKey);
      if (orig) duplicates.push({ original: orig, duplicate: v });
      continue;
    }
    seen.add(urlKey);

    const key = `${normaliseText(v.employer)}||${normaliseText(v.title)}`;
    if (seen.has(key)) {
      const orig = kept.find((k) => `${normaliseText(k.employer)}||${normaliseText(k.title)}` === key);
      if (orig) duplicates.push({ original: orig, duplicate: v });
      continue;
    }
    seen.add(key);

    if (v.id) {
      const idKey = `id:${v.id}`;
      if (seen.has(idKey)) {
        const orig = kept.find((k) => k.id === v.id);
        if (orig) duplicates.push({ original: orig, duplicate: v });
        continue;
      }
      seen.add(idKey);
    }

    kept.push(v);
  }

  return { kept, duplicates };
}
