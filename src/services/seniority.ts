/**
 * Seniority eligibility for the default junior-role shortlist.
 *
 * `isClearlySeniorTitle` decides whether a listing's *title* names a clearly
 * senior role: Senior/Sr., Lead, Principal, Staff, Head of Engineering,
 * Engineering Manager, Director, C-suite/VP, chief or architect-level. Such
 * roles are excluded from the default junior/graduate shortlist unless the
 * user explicitly asked for senior roles (`requestsSeniorRoles`).
 *
 * The patterns are deliberately conservative so everyday words used in
 * non-senior senses never trip the rule:
 *
 * - "lead" must be tied to a development-role noun ("Lead Software Developer",
 *   "Lead QA Engineer", "Tech Lead") — never "Lead Generation Specialist",
 *   "Sales Lead" or "Lead Administrator".
 * - "staff" must precede an engineer/developer noun — never "Staffing
 *   Consultant".
 * - "head/director" must qualify an engineering/technology function — never
 *   "Head of Sales".
 * - "principal" must precede an engineering noun — never "Principal
 *   Accountant".
 */

const DEV_ROLE_NOUNS =
  '(?:software\\s+)?(?:developer|engineer|programmer|dev)|' +
  '(?:full[ -]?stack|front[ -]?end|back[ -]?end|web|data(?:base)?|devops|' +
  'platform|cloud|sre|qa|quality|test(?:ing)?|automation|sdet)';

const SENIOR_TITLE_PATTERNS: readonly RegExp[] = [
  // Explicit "senior"/"sr." is unambiguous in a role title.
  /\b(?:senior|sr\.?)\b/i,
  // Lead tied to a development role.
  new RegExp(`\\blead\\s+(?:${DEV_ROLE_NOUNS})\\b`, 'i'),
  // Standalone team/tech/engineering/development lead.
  /\b(?:team|tech|engineering|development)\s+lead\b/i,
  // Principal in engineering/development contexts.
  /\bprincipal\s+(?:software\s+)?(?:developer|engineer|programmer|architect|consultant|devops|data|sre|qa|test|automation|platform|cloud|sdet)\b/i,
  // Staff-level engineer/developer (never "staffing"/"staff").
  /\bstaff\s+(?:software\s+)?(?:engineer|developer|programmer|sre|devops|platform|data)\b/i,
  // Head/Director of an engineering or technology function.
  /\b(?:head|director)\s+of\s+(?:engineering|technology|software(?:\s+development)?|development|data|platform|devops|cloud|it|digital|product|design)\b/i,
  // Engineering/technology director or manager.
  /\b(?:engineering|technical|technology|software|development|devops|it|digital)\s+(?:director|manager)\b/i,
  // Engineering / development / platform manager (not "Product Manager").
  /\b(?:engineering|development|devops|platform|cloud)\s+manager\b/i,
  /\bmanager\s+of\s+(?:software\s+(?:development|engineering)|engineering|development)\b/i,
  // C-suite / VP / Chief.
  /\b(?:chief|cto|cfo|cio|coo|vice\s+president|vp)\b/i,
  // Architect-level positions are senior technical roles.
  /\barchitect\b/i,
];

/** Keywords a user might type to explicitly ask for senior roles. */
const SENIOR_REQUEST_RE =
  /\b(senior|sr\.?|lead|principal|staff|head|director|vice president|vp|chief|cto|architect|engineering manager|manager)\b/i;

/** True when the role title names a clearly senior position. */
export function isClearlySeniorTitle(title: string): boolean {
  return SENIOR_TITLE_PATTERNS.some(pattern => pattern.test(title));
}

/**
 * True when the user's search keywords explicitly request senior roles, in
 * which case the seniority eligibility rule is waived.
 */
export function requestsSeniorRoles(keywords: readonly string[] | undefined): boolean {
  if (keywords === undefined || keywords.length === 0) return false;
  return keywords.some(keyword => SENIOR_REQUEST_RE.test(keyword));
}