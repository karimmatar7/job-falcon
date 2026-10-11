import type { LocationEligibility, Vacancy } from '../models/vacancy.js';

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
  react: ['react', 'reactjs', 'react.js'],
  'web development': [
    'web',
    'frontend',
    'front-end',
    'fullstack',
    'full-stack',
    'web dev',
    'html',
    'css',
    'next.js',
    'node',
  ],
  sql: ['sql', 'postgres', 'postgresql', 'mysql', 'database'],
  drupal: ['drupal'],
  testing: ['test', 'testing', 'jest', 'vitest', 'cypress', 'playwright', 'qa'],
  supabase: ['supabase'],
  figma: ['figma'],
  adobe: ['adobe', 'photoshop', 'illustrator'],
  arduino: ['arduino'],
  raspberry: ['raspberry pi'],
  'ai tools': ['opencode', 'claude', 'codex', 'openai', 'github copilot', 'chatgpt', 'llm'],
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
  'london',
  'birmingham',
  'bristol',
  'nottingham',
  'newcastle',
] as const;

const ENTRY_LEVEL_RE = /\b(junior|graduate|entry[ -]?level|entry|trainee|intern|internship|apprentice)\b/i;
const TECH_ROLE_RE =
  /\b(developer|engineer|programmer|software|web|front[ -]?end|back[ -]?end|full[ -]?stack|fullstack|qa|quality assurance|tester|test engineer|test automation|automation|devops|data)\b/i;
const STRONG_SENIOR_RE =
  /\b(principal|staff|distinguished|chief|head of|director|vp|vice president|architect)\b/i;
/**
 * Seniority signals used for *scoring*. "lead" and "manager" are only senior
 * signals inside development/engineering contexts, so "Lead Generation
 * Specialist", "Sales Lead" or "Project Manager" are never penalised as
 * "senior" roles — matching the eligibility rule in `seniority.ts`.
 */
const SENIOR_RE =
  /\b(senior|sr\.?|team lead|tech lead)\b|\blead\s+(?:software\s+)?(?:developer|engineer|programmer|dev)\b|\blead\s+(?:full[ -]?stack|front[ -]?end|back[ -]?end|web|data(?:base)?|devops|platform|cloud|sre|qa|quality|test(?:ing)?|automation|sdet)\b|\b(?:engineering|technical|technology|software|development|devops|it|digital)\s+manager\b|\bmanager\s+of\s+(?:software\s+)?(?:development|engineering)\b/i;
const NON_TECH_ROLE_RE =
  /\b(sales|account executive|writer|copywriter|content reviewer|reviewer|assistant|recruiter|marketing|support|service desk|help desk|evaluator|annotator|customer service)\b/i;
const AI_RE = /\b(ai|artificial intelligence|machine learning|ml|llm)\b/i;
/**
 * QA/testing/automation roles call on transferable skills (finding bugs,
 * writing checks, owning test plans), so their *primary language* is never the
 * deciding factor: mandatory C#/Java in an SDET advert is not the same signal
 * as mandatory C#/.NET in a pure development advert.
 */
const QA_ROLE_RE =
  /\b(qa|quality assurance|quality engineer|test engineer|tester|test automation|automation engineer|sdet|software development engineer in test)\b/i;
const DEGREE_RE = /\b(intern|internship|placement|degree|bsc|ba|qualification|graduate)\b/i;

/**
 * The user's primary languages/frameworks. A role that *requires* one of these
 * is a genuine match; a role that merely mentions one is not.
 */
const CORE_SKILL_KEYS = ['javascript', 'typescript', 'react'] as const;

/**
 * Languages/frameworks that define a role's primary stack but are outside the
 * user's strengths. Only a *mandatory* requirement for one of these penalises a
 * listing; an incidental mention never does.
 */
const FOREIGN_PRIMARY_TECH: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'C#', re: /(^|[^a-z0-9])c#([^a-z0-9]|$)/i },
  { name: 'ASP.NET', re: /\basp\.?net\b/i },
  { name: '.NET', re: /(^|[^a-z0-9])\.net\b|\bdotnet\b/i },
  { name: 'VB.NET', re: /\bvb\.?net\b/i },
  { name: 'Java', re: /(^|[^a-z0-9])java([^a-z0-9]|$)/i },
  { name: 'PHP', re: /(^|[^a-z0-9])php([^a-z0-9]|$)/i },
  { name: 'Ruby', re: /(^|[^a-z0-9])ruby([^a-z0-9]|$)|\bruby on rails\b|\brails\b/i },
  { name: 'C++', re: /c\+\+/i },
  { name: 'Go', re: /\bgolang\b/i },
  { name: 'Rust', re: /(^|[^a-z0-9])rust([^a-z0-9]|$)/i },
  { name: 'Kotlin', re: /(^|[^a-z0-9])kotlin([^a-z0-9]|$)/i },
  { name: 'Swift', re: /(^|[^a-z0-9])swift([^a-z0-9]|$)/i },
  { name: 'Scala', re: /(^|[^a-z0-9])scala([^a-z0-9]|$)/i },
  { name: 'Perl', re: /(^|[^a-z0-9])perl([^a-z0-9]|$)/i },
  { name: 'Spring', re: /\bspring\s+(?:boot|framework)\b/i },
  { name: 'Django', re: /(^|[^a-z0-9])django([^a-z0-9]|$)/i },
  { name: 'Laravel', re: /(^|[^a-z0-9])laravel([^a-z0-9]|$)/i },
];

/**
 * Wording that marks a clause as a mandatory requirement. Only clauses carrying
 * one of these markers are treated as "required"; everything else is treated as
 * incidental context, so an unfamiliar technology can be mentioned freely.
 */
const MANDATORY_RE =
  /\b(must[ -]?have|must[ -]?be|required|requirement|essential|mandatory|proven|commercial(?:ly)?\s+experience|strong\s+(?:experience|knowledge|background|understanding)|solid\s+experience|expert(?:ise)?\s+in|proficien(?:t|cy)\s+(?:in|with)|experience\s+(?:in|with|of)|knowledge\s+of|you\s+will\s+(?:need|have)|at\s+least|minimum\s+of)\b/i;


const UK_RE =
  /(^|[^a-z])(united kingdom|uk|england|scotland|wales|northern ireland|great britain|britain|british)([^a-z]|$)/i;
const OPEN_RE = /\b(worldwide|anywhere|global|remote|europe|emea|eu)\b/i;
/**
 * Explicitly foreign markers. Only a clear non-UK signal makes a listing
 * ineligible: UK-only sources such as Adzuna `gb` return plain British place
 * names ("Liverpool, Merseyside", "Maritime Quarter, Swansea") that carry no
 * country word at all, so "unknown but specific" must stay eligible rather
 * than silently dropping genuinely UK jobs.
 */
const NON_UK_RE =
  /\b(usa|united states|america|canada|mexico|india|pakistan|bangladesh|sri lanka|nepal|philippines|philippine|singapore|indonesia|malaysia|china|japan|taiwan|hong kong|south korea|korea|vietnam|thailand|australia|new zealand|germany|france|spain|italy|netherlands|holland|belgium|switzerland|austria|poland|czech|sweden|norway|denmark|finland|turkey|israel|uae|dubai|qatar|saudi arabia|south africa|nigeria|ghana|kenya|brazil|argentina|chile|colombia|peru|new york|san francisco|los angeles|chicago|seattle|austin|boston|denver|miami|toronto|vancouver|sydney|melbourne|berlin|munich|paris|dublin|amsterdam|brussels|zurich|geneva|vienna|warsaw|prague|stockholm|oslo|copenhagen|helsinki|barcelona|madrid|milan|rome|lisbon|athens|bangalore|mumbai|delhi|tokyo|seoul|shanghai|shenzhen|beijing|hanoi|manila|jakarta|bangkok|lagos|nairobi|republic of ireland|eastern time|central time|pacific time|usa timezones)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-token match so "web" does not match "webinar" and "js" does not match "json". */
function containsTerm(text: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}([^a-z0-9]|$)`, 'i').test(text);
}

/**
 * The description's requirement clauses, i.e. sentences carrying a mandatory
 * marker. Periods are only sentence separators when NOT glued to a letter or
 * digit, so a ".NET"/".Net" token is never split into ".NET" fragments.
 */
function mandatoryClauses(description: string): string[] {
  return description
    .split(/(?:\.(?![A-Za-z0-9])|[;\n\r•·\u2022]|\s{2,})/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && MANDATORY_RE.test(part));
}

/**
 * Penalise a role whose *mandatory* stack is dominated by primary technologies
 * outside the user's profile (for example commercial C#/.NET), so a single
 * keyword such as React cannot make it look strongly aligned.
 *
 * Only mandatory requirements (and the title, which names the role's stack)
 * count. A role is never penalised when:
 *
 * - its title names a core-language role ("React Developer"),
 * - its mandatory requirements name at least as many core skills as foreign
 *   ones ("Essential: React, C#" is genuinely mixed; "Essential: C#/.NET,
 *   SQL Server" is not), or
 * - it is a QA/testing/automation role, which calls on transferable skills.
 *
 * An incidental mention of an unfamiliar technology never penalises.
 */
function stackMismatchPenalty(vacancy: Vacancy): { penalty: number; reason?: string } {
  const title = vacancy.title.toLowerCase();
  const description = vacancy.description ?? '';
  const requirements = mandatoryClauses(description).join(' ');

  // Testing/QA roles rely on transferable skills; their language alone is
  // never the deciding factor.
  if (QA_ROLE_RE.test(title)) return { penalty: 0 };

  const foreignInTitle = FOREIGN_PRIMARY_TECH.filter((tech) => tech.re.test(title));
  const foreignInRequirements = FOREIGN_PRIMARY_TECH.filter(
    (tech) => requirements.length > 0 && tech.re.test(requirements),
  );
  const foreign = new Set(
    [...foreignInTitle, ...foreignInRequirements].map((tech) => tech.name),
  );
  if (foreign.size === 0) return { penalty: 0 };

  const coreTerms = CORE_SKILL_KEYS.flatMap((key) => SKILLS_MAP[key] ?? [key]);
  const coreInTitle = coreTerms.filter((term) => containsTerm(title, term));
  // A title that names the role's core stack is not penalised for a foreign
  // mention elsewhere (existing behaviour, kept to avoid over-rejection).
  if (coreInTitle.length > 0 && foreignInTitle.length === 0) return { penalty: 0 };

  const coreRequiredCount = new Set(
    coreTerms.filter((term) => containsTerm(requirements, term)),
  ).size;
  const foreignCount = foreign.size;

  // Core skills are co-required at least as often as foreign ones: the stack
  // is genuinely mixed, so no mismatch penalty.
  if (coreRequiredCount > 0 && foreignCount <= coreRequiredCount) return { penalty: 0 };

  const names = [...foreign];
  return {
    // A lone core-skill co-requirement does not rescue a foreign-dominant
    // mandatory stack: the penalty is exactly as strong as for a fully
    // foreign stack, so the role falls below the alternative bar.
    penalty: 35,
    reason: `penalised: mandatory ${names.join('/')} requirements outweigh matching core skills`,
  };
}

/**
 * Best-effort, deliberately conservative assessment of whether a listing is
 * open to UK-based candidates. Explicit UK wording alone is `eligible`; global/
 * remote wording is `possibly`; an explicit foreign country/region signal is
 * `ineligible`; any other specific location (plain British place names, as
 * returned by UK-only sources) is `eligible`. This is an inference from the
 * stated location, not a verified fact, and is recorded as such.
 *
 * A listing that names *both* the UK and explicit foreign locations (for
 * example "USA, UK, India, Australia, ...") does not establish UK eligibility:
 * mentioning the UK once among many countries does not mean UK-based candidates
 * are accepted. Such mixed listings are reported as `possibly` rather than
 * `eligible`, so the bot never presents uncertain multi-country eligibility as
 * a confirmed UK match. (They are still shown, just labelled honestly.)
 */
export function assessLocationEligibility(location: string): LocationEligibility {
  const value = location.trim();
  if (value.length === 0) return 'possibly';
  const mentionsUk = UK_RE.test(value);
  const mentionsNonUk = NON_UK_RE.test(value);
  if (mentionsUk && mentionsNonUk) return 'possibly';
  if (mentionsUk) return 'eligible';
  if (OPEN_RE.test(value)) return 'possibly';
  if (mentionsNonUk) return 'ineligible';
  return 'eligible';
}

/** Highest whole-number of years of experience the description demands, if any. */
export function extractRequiredYears(text: string): number | null {
  let max: number | null = null;
  const re = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0 && (max === null || value > max)) max = value;
  }
  return max;
}

interface SkillMatch {
  readonly required: readonly string[];
  readonly incidental: readonly string[];
}

/**
 * Profile skills that appear in a listing, split into those belonging to the
 * role's *stated requirements* (the title, which names the role's stack, and
 * mandatory requirement clauses) and those that are only incidental mentions.
 *
 * Required matches are weighted far more heavily than incidental ones, so a
 * single offhand React mention cannot make an otherwise C#/.NET role look
 * aligned, while an incidental mention still earns a little credit and never
 * auto-rejects the role.
 */
function analyzeMatchedSkills(vacancy: Vacancy, profile: Profile): SkillMatch {
  const text = vacancyText(vacancy);
  const requiredPool = `${vacancy.title} ${mandatoryClauses(vacancy.description ?? '').join(' ')}`;
  const skillsList = profile.skills ?? [...DEFAULT_SKILLS];
  const required: string[] = [];
  const incidental: string[] = [];
  for (const skill of skillsList) {
    const normalizedSkill = skill.toLowerCase().trim();
    const terms = SKILLS_MAP[normalizedSkill] ?? [normalizedSkill];
    if (!terms.some((term) => containsTerm(text, term))) continue;
    if (terms.some((term) => containsTerm(requiredPool, term))) required.push(skill);
    else incidental.push(skill);
  }
  return { required, incidental };
}

function vacancyText(vacancy: Vacancy): string {
  return `${vacancy.title} ${vacancy.location} ${vacancy.description ?? ''}`.toLowerCase();
}

interface ScoreBreakdown {
  readonly score: number;
  readonly matched: readonly string[];
  readonly reasons: readonly string[];
}

function breakdown(vacancy: Vacancy, profile: Profile): ScoreBreakdown {
  const title = vacancy.title.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (TECH_ROLE_RE.test(title)) {
    score += 20;
    reasons.push('tech role fit');
  }
  if (ENTRY_LEVEL_RE.test(title)) {
    score += 20;
    reasons.push('entry-level / graduate role');
  }
  if (DEGREE_RE.test(title)) {
    score += 5;
    reasons.push('relevant qualification signal');
  }

  if (STRONG_SENIOR_RE.test(title)) {
    score -= 30;
    reasons.push('penalised: staff/principal/architect-level role');
  } else if (SENIOR_RE.test(title)) {
    score -= 22;
    reasons.push('penalised: senior/lead role');
  }

  if (NON_TECH_ROLE_RE.test(title)) {
    score -= 20;
    reasons.push('penalised: non-development role');
  }

  const requiredYears = extractRequiredYears(`${vacancy.title} ${vacancy.description ?? ''}`);
  if (requiredYears !== null && requiredYears >= 5) {
    score -= 20;
    reasons.push(`penalised: asks for ${requiredYears}+ years`);
  } else if (requiredYears !== null && requiredYears >= 3) {
    score -= 10;
    reasons.push(`penalised: asks for ${requiredYears}+ years`);
  }

  // A senior role that also demands several years of experience is doubly out
  // of reach for a junior/graduate profile; drop it below the alternative bar.
  if (requiredYears !== null && requiredYears >= 4 && !STRONG_SENIOR_RE.test(title) && SENIOR_RE.test(title)) {
    score -= 15;
    reasons.push('penalised: senior/lead role demanding 4+ years');
  }

  const mismatch = stackMismatchPenalty(vacancy);
  if (mismatch.penalty > 0) {
    score -= mismatch.penalty;
    if (mismatch.reason !== undefined) reasons.push(mismatch.reason);
  }

  const skills = analyzeMatchedSkills(vacancy, profile);
  const matched = [...skills.required, ...skills.incidental];
  if (matched.length > 0) {
    // Required/core matches are weighted well above incidental mentions.
    score += Math.min(30, skills.required.length * 8 + skills.incidental.length * 3) + 5;
    const label = [...skills.required, ...skills.incidental].slice(0, 3).join(', ');
    reasons.push(`matching skills: ${label}${skills.required.length > 0 ? ' (required)' : ''}`);
  }

  // A listing that supplied enough text to be judged but shows none of the
  // profile's skills is a weak fit for a skill-driven junior shortlist: a bare
  // generic "Software Developer" advert with no demonstrated skill overlap
  // should not out-rank nothing (title + location alone are not enough).
  // Entry-level and QA/testing wording is exempt (the applicant grows into the
  // role / calls on transferable skills), a listing without a description
  // cannot be judged and is exempt, and confirmed vacancies are never touched
  // so sponsorship results keep their score.
  if (
    matched.length === 0 &&
    (vacancy.description ?? '').trim().length > 0 &&
    !ENTRY_LEVEL_RE.test(title) &&
    !QA_ROLE_RE.test(title) &&
    vacancy.vacancySponsorshipStatus !== 'confirmed'
  ) {
    score -= 12;
    reasons.push('penalised: listing text shows no profile skill match');
  }

  const preferred = profile.locations ?? [...DEFAULT_LOCATIONS];
  const eligibility = assessLocationEligibility(vacancy.location);
  if (eligibility === 'eligible') {
    score += 15;
    if (preferred.some((loc) => containsTerm(vacancy.location, loc))) {
      reasons.push('preferred location match');
    } else {
      reasons.push('UK-eligible location');
    }
  } else if (eligibility === 'possibly') {
    score += 5;
    reasons.push('remote/region unclear for UK');
  } else {
    reasons.push('location appears to exclude the UK');
  }

  if (AI_RE.test(title)) {
    score += 5;
    reasons.push('AI-related role');
  }

  if (reasons.length === 0) reasons.push('general fit');

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    matched,
    reasons,
  };
}

export function computeMatchScore(vacancy: Vacancy, profile: Profile = {}): number {
  return breakdown(vacancy, profile).score;
}

export function explainMatch(vacancy: Vacancy, score: number, profile: Profile = {}): string {
  const { reasons } = breakdown(vacancy, profile);
  return `Score ${score}/100: ${reasons.join(', ')}`;
}
