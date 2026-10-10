
import type { Vacancy } from '../models/vacancy.js';

export interface Profile {
  readonly keywords?: readonly string[];
  readonly skills?: readonly string[];
  readonly locations?: readonly string[];
  readonly degree?: string;
  readonly qualification?: string;
  readonly experience?: string;
  readonly exclusions?: readonly string[];
}

const SKILLS_MAP: Record<string, readonly string[]> = {
  javascript: ['javascript', 'js'],
  typescript: ['typescript', 'ts'],
  react: ['react', 'reactjs'],
  'web development': [
    'web',
    'frontend',
    'front-end',
    'fullstack',
    'full-stack',
    'web dev',
  ],
  sql: ['sql', 'postgres', 'postgresql', 'database'],
  drupal: ['drupal'],
  testing: ['test', 'testing', 'jest', 'vitest'],
  supabase: ['supabase'],
  figma: ['figma'],
  adobe: ['adobe', 'photoshop', 'illustrator'],
  arduino: ['arduino'],
  raspberry: ['raspberry pi'],
  'ai tools': ['opencode', 'claude', 'codex', 'openai', 'github copilot'],
};

const DEFAULT_SKILLS = [
  'javascript',
  'typescript',
  'react',
  'web development',
  'sql',
] as const;

const DEFAULT_LOCATIONS = [
  'barnsley',
  'sheffield',
  'leeds',
  'manchester',
  'yorkshire',
] as const;

export function computeMatchScore(
  vacancy: Vacancy,
  profile: Profile = {},
): number {
  const title = vacancy.title.toLowerCase();
  const location = vacancy.location.toLowerCase();
  const text = `${title} ${location}`;

  let score = 0;

  if (/\b(junior|graduate|entry|entry-level|trainee)\b/i.test(title)) {
    score += 20;
  }

  if (
    /\b(developer|engineer|software|web|frontend|fullstack|digital|quality|qa|tester|testing|test|automation)\b/i.test(
      title,
    )
  ) {
    score += 20;
  }

  const skillsList = profile.skills ?? [...DEFAULT_SKILLS];
  const matchedSkills = skillsList.filter((skill) => {
    const normalizedSkill = skill.toLowerCase().trim();
    const terms = SKILLS_MAP[normalizedSkill] ?? [normalizedSkill];

    return terms.some((term) => text.includes(term));
  });

  score += Math.min(30, matchedSkills.length * 5);

  const preferred = profile.locations ?? [...DEFAULT_LOCATIONS];

  if (
    preferred.some((loc) => location.includes(loc.toLowerCase().trim()))
  ) {
    score += 20;
  }

  if (
    /\b(uk|united kingdom|england|britain|british)\b/i.test(text)
  ) {
    score += 10;
  }

  if (
    /\b(intern|placement|degree|bsc|ba|qualification|graduate)\b/i.test(
      title,
    )
  ) {
    score += 5;
  }

  if (matchedSkills.length > 0) {
    score += 5;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function explainMatch(
  vacancy: Vacancy,
  score: number,
  profile: Profile = {},
): string {
  const parts: string[] = [];
  const title = vacancy.title.toLowerCase();
  const location = vacancy.location.toLowerCase();

  if (/\b(junior|graduate|entry|trainee)\b/i.test(title)) {
    parts.push('entry-level role');
  }

  if (
    /\b(developer|engineer|software|web|frontend|fullstack|quality|qa|tester|testing|test|automation)\b/i.test(
      title,
    )
  ) {
    parts.push('tech role fit');
  }

  const skillsList = profile.skills ?? [...DEFAULT_SKILLS];

  const matchedSkills = skillsList.filter((skill) => {
    const normalizedSkill = skill.toLowerCase().trim();
    const terms = SKILLS_MAP[normalizedSkill] ?? [normalizedSkill];

    return terms.some((term) => title.includes(term));
  });

  if (matchedSkills.length > 0) {
    parts.push(`matching skills: ${matchedSkills.slice(0, 3).join(', ')}`);
  }

  const preferred = profile.locations ?? [...DEFAULT_LOCATIONS];

  if (
    preferred.some((loc) => location.includes(loc.toLowerCase().trim()))
  ) {
    parts.push('location match');
  }

  if (parts.length === 0) {
    parts.push('general fit');
  }

  return `Score ${score}/100: ${parts.join(', ')}`;
}