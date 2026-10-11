/**
 * Parse the arguments of the Telegram `/search` command.
 *
 * Documented, unambiguous forms (all backwards compatible):
 *
 *   /search                              -> defaults: limit 5, default keywords
 *   /search 8                            -> numeric limit only (1-10, clamped)
 *   /search javascript leeds             -> keywords "javascript", location "leeds"
 *   /search software developer leeds     -> keywords "software developer", location "leeds"
 *   /search 8 software developer leeds   -> limit 8 + the same keyword/location split
 *
 * A numeric limit is only recognised when the FIRST token is a plain integer
 * (`/^[+-]?\d+$/`). Any other first token - including ordinary words and
 * mixed tokens such as `3d` - is treated as a keyword, so words are never
 * mistaken for a limit. The location is a trailing known UK place name
 * (matched longest-first over 1-2 tokens); everything before it is keywords.
 *
 * `keywords` may be empty, in which case the search service substitutes its
 * own compact default query. This keeps `/search`, `/search 5` and
 * `/search leeds` all working.
 */

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 10;

export const SEARCH_USAGE = [
  'Usage: /search [limit] [keywords] [location]',
  'Examples: /search, /search 5, /search software developer leeds',
].join('\n');

/** Recognises a plain integer token (optionally signed). */
const INTEGER_RE = /^[+-]?\d+$/;

/**
 * Known UK places accepted at the end of a query. Multi-word entries are
 * matched before single words, so "milton keynes" is not split into a keyword
 * plus a bogus location. This is deliberately a fixed list (not a gazetteer):
 * unknown trailing words stay keywords, exactly as typed.
 */
const KNOWN_LOCATIONS = new Set<string>([
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
  'liverpool',
  'swansea',
  'cardiff',
  'edinburgh',
  'glasgow',
  'belfast',
  'bath',
  'cambridge',
  'oxford',
  'reading',
  'brighton',
  'southampton',
  'portsmouth',
  'leicester',
  'coventry',
  'hull',
  'derby',
  'york',
  'norwich',
  'plymouth',
  'aberdeen',
  'dundee',
  'preston',
  'bolton',
  'wigan',
  'wakefield',
  'doncaster',
  'rotherham',
  'chesterfield',
  'huddersfield',
  'bradford',
  'halifax',
  'lincoln',
  'worcester',
  'gloucester',
  'swindon',
  'exeter',
  'ipswich',
  'milton keynes',
  'stoke on trent',
  'newcastle upon tyne',
  'kingston upon hull',
  'southend on sea',
]);

export interface SearchArgs {
  readonly limit: number;
  /** Empty means "use the service's default query". */
  readonly keywords: string[];
  readonly location?: string;
}

export type SearchArgsResult =
  | ({ readonly ok: true } & SearchArgs)
  | { readonly ok: false; readonly message: string };

/** Split trailing known-location tokens from the keyword tokens. */
function splitKeywordsAndLocation(tokens: readonly string[]): {
  keywords: string[];
  location?: string;
} {
  for (const size of [2, 1]) {
    if (tokens.length < size) continue;
    const suffix = tokens.slice(tokens.length - size);
    const candidate = suffix.join(' ').toLowerCase();
    if (KNOWN_LOCATIONS.has(candidate)) {
      return {
        keywords: tokens.slice(0, tokens.length - size),
        location: suffix.join(' '),
      };
    }
  }
  return { keywords: [...tokens] };
}

export function parseSearchArgs(rawArgs: readonly string[]): SearchArgsResult {
  const args = rawArgs.filter((token) => token.length > 0);
  let index = 0;
  let limit = DEFAULT_SEARCH_LIMIT;

  const first = args[0];
  if (first !== undefined && INTEGER_RE.test(first)) {
    const parsed = Number(first);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, message: SEARCH_USAGE };
    }
    limit = Math.min(parsed, MAX_SEARCH_LIMIT);
    index = 1;
  }

  const { keywords, location } = splitKeywordsAndLocation(args.slice(index));
  return {
    ok: true,
    limit,
    keywords,
    ...(location === undefined ? {} : { location }),
  };
}