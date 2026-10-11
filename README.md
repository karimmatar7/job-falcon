# JobFalcon Bot

A personal UK job-hunting Telegram bot. It searches configured job sources and
is intentionally strict about one thing above all: **it only reports a vacancy
as having confirmed sponsorship when that vacancy's own text explicitly offers
it.** Everything weaker is labelled as such.

## Commands

| Command   | Purpose                                                        |
| --------- | ------------------------------------------------------------- |
| `/start`  | Greeting and short usage note.                                |
| `/help`   | List available commands.                                      |
| `/status` | Show configuration and source status.                         |
| `/search` | Search sources, returning confirmed-sponsorship vacancies first and up to five clearly-labelled unconfirmed alternatives. |

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` – from [@BotFather](https://t.me/BotFather)
   - `TELEGRAM_ALLOWED_USER_ID` – your numeric id from [@userinfobot](https://t.me/userinfobot)
   - *(optional)* `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` – enables the UK Adzuna source
   - *(optional)* `UK_SPONSOR_REGISTER_URL` – enables employer sponsor-register checks (see below)
   - *(optional)* `JOB_SCOUT_DEBUG_DECISIONS` – per-listing audit log for diagnosing result counts
3. `npm run dev` (watch mode) or `npm start`.

`.env` is personal data and must never be committed or logged.


## Scripts

| Script              | Effect                          |
| ------------------- | ------------------------------- |
| `npm run dev`       | Run the bot with file watching. |
| `npm start`         | Run the bot once.               |
| `npm run build`     | Compile to `dist/`.             |
| `npm run typecheck` | `tsc --noEmit`.                 |
| `npm test`          | Run the Vitest suite once.      |

## How sponsorship is verified

Verification is **evidence-based and conservative**, and it keeps two different
questions strictly apart:

- **Vacancy-level:** does *this advertised role* offer sponsorship?
- **Employer-level:** is the *employing organisation* on the government's
  register of licensed sponsors?

Employer registration never upgrades a vacancy to "confirmed". A licensed
employer can still advertise a role that does not sponsor.

### Vacancy-level evidence states

Every returned listing carries one of four evidence states
(`src/models/vacancy.ts`, `src/services/sponsorship.ts`):

| State | Meaning |
| ----- | ------- |
| `vacancy_sponsorship_confirmed` | The vacancy's own text explicitly offers visa sponsorship. |
| `sponsorship_unavailable` | The vacancy explicitly refuses sponsorship, or requires existing unrestricted UK work rights. |
| `employer_sponsor_verified` | The relevant employer is on the official register, but this vacancy's policy is unknown. |
| `unconfirmed` | Evidence is missing, ambiguous, conflicting or unavailable. |

`classifySponsorship()` (`src/services/sponsorship.ts`) scans the vacancy's own
title, employer name and description in this order:

1. **Licence scan** – records whether the listing mentions a UK sponsor licence
   (`employerSponsorLicence = yes|no|unknown`). A licence is stored as a
   *separate* fact and **never** upgrades a vacancy to `confirmed`.
2. **Explicit refusal scan** – "unable to sponsor", "no visa sponsorship",
   "do not provide visa assistance", etc. → `not_offered`. A refusal wins over
   a conflicting positive statement, so conflicting text is never `confirmed`.
3. **Explicit support scan** – "visa sponsorship", "will sponsor",
   "able to sponsor", "sponsorship available", etc. → `confirmed`.
4. **Otherwise** → `unclear` (silence is never treated as support).

For every classification it stores the official source URL, the **exact
sentence** containing the match, a machine-readable reason and the check time,
so a human can re-check it.

### Employer register verification

`src/services/sponsorRegister.ts` optionally verifies the employing
organisation against the official
[Register of licensed sponsors: workers](https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers).

Set **one** of these in `.env` to enable it:

```
# Stable publication page: newest CSV discovered automatically (recommended).
UK_SPONSOR_REGISTER_URL=https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers

# Or a direct CSV export copied from that page:
# UK_SPONSOR_REGISTER_URL=https://assets.publishing.service.gov.uk/media/.../register-of-licensed-sponsors-workers-2026-01-01.csv
```

Behaviour and safeguards:

- **Disabled by default.** With no URL set, a no-op register returns
  "unavailable" and nothing is claimed — no network requests are made.
- **Cached.** The parsed snapshot is cached for 24 hours and reused across
  `/search` calls; a failed/timed-out download is remembered for 5 minutes so a
  broken URL cannot trigger a request per vacancy.
- **Retrieval/update date recorded** (`sponsorRegisterRetrievedAt`,
  `sponsorRegisterUpdatedAt`) where the filename or HTTP `Last-Modified` exposes
  it.
- **Conservative matching.** Names are normalised (case, accents, punctuation,
  `&`/`and`, and common legal suffixes such as Ltd/Limited/PLC) and only exact
  normalised equality counts as a match. Too-short or generic names are refused.
  No fuzzy matching.
- **Not-found is not a denial.** A missing entry means the employer may use a
  different legal or trading name; it is never reported as "unlicensed".

### Recruiters vs end employers

`src/services/employerIdentity.ts` separates the *advertiser* from the *end
employer*. When a listing is clearly from a recruitment agency:

- The only meaningful register target is the **end employer**.
- If the agency does not name its client, the target is **unknown** and nothing
  is checked or claimed — an agency's own licence proves nothing about the role.
- A no-sponsorship statement applies only to the exact vacancy it appears in; it
  is never generalised to every vacancy from that advertiser.

`/search` shows confirmed vacancies first, then up to five genuinely relevant
alternatives labelled `UNCONFIRMED`. Each vacancy card carries the vacancy-level
sponsorship status **and** a separate, concise employer-register line, plus a
short explanation and a link to the original vacancy. The register line reports
one of four outcomes and never changes the vacancy verdict:

| Register line | Meaning |
| --- | --- |
| `LICENSED SPONSOR - matched "..." on the official register` | An exact register match; the register update date is included when known. Never implies this vacancy offers sponsorship. |
| `no exact match on the official register` | No exact match; explicitly **not** proof the employer is unlicensed (legal/trading names can differ). |
| `could not be checked (register unavailable)` | The register could not be read; no conclusion either way. |
| `not checked - advertised by a recruitment agency ...` | The advertiser is an agency and the hiring employer was not identified, so the agency's own licence is irrelevant. |

## Diagnosing the result count

Every `/search` reply ends with a coverage line, e.g.:

```
Coverage: sources [remotive 18/18, adzuna 40/40]; checked 58 listing(s).
Excluded: closed=0, paid_training=2, senior=6, location_ineligible=4, not_offered=2,
duplicates=12, tpp=0, invalid=0, over_cap=7, low_relevance=20, confirmed_over_limit=0.
```

The counters are ordered as the pipeline applies them, so
`checked = excluded (including confirmed_over_limit) + confirmed + alternatives`:

| Counter | Stage |
| --- | --- |
| `closed`, `paid_training`, `senior`, `location_ineligible`, `not_offered`, `tpp`, `invalid` | early filters (paid_training excludes fee-charging courses/bootcamps/self-funded placement adverts; senior excludes clearly senior titles unless senior roles were explicitly requested) |
| `duplicates` | de-duplication (exact URL, then `employer+title+location`, then id) |
| `confirmed_over_limit` | confirmed sponsorship vacancies that were real results but exceeded the `/search` limit, so they were not displayed |
| `over_cap` | relevant (`score >= 25`) alternatives beyond the 5-alternative cap |
| `low_relevance` | unclear listings below the relevance floor (`score < 25`) |

`over_cap` and `low_relevance` are distinct on purpose: before this counter
existed, below-threshold drops were invisible and the totals did not reconcile.
`confirmed_over_limit` exists for the same reason on the confirmed side: a
confirmed vacancy dropped by the result limit is a real result, not a lost one.

De-duplication treats location as part of a listing's identity, so the same
employer and title advertised in several places (for example one placement
programme across nine UK cities) are kept as distinct adverts. Only genuine
reposts — same employer, title *and* location, or the same URL/id — collapse.

## Job quality and apply links

- **Fee-charging adverts are not jobs.** `src/services/listingQuality.ts`
  conservatively excludes training courses, paid bootcamps and self-funded
  placement programmes that charge the applicant (self-funding wording, or an
  explicit fee plus a training/placement context). A legitimate paid job that
  merely offers training — or says the employer covers fees — is never
  excluded. Excluded adverts are counted as `paid_training` in the coverage
  note.
- **Apply links are validated, never substituted.** `src/services/applicationUrl.ts`
  and the pipeline in `jobSearch.ts` drop any application URL that is missing,
  malformed, or just the source's homepage, and record why it is unavailable.
  A source homepage is never shown as the apply link, and no other URL is
  silently put in its place; the vacancy card says `Apply: link unavailable`.
- **Mandatory skills are distinguished from incidental mentions, and required
  skills out-weigh incidental ones.** `relevanceScoring.ts` penalises a role
  whose *mandatory* requirements are dominated by a primary technology outside
  the profile (e.g. commercial C#/.NET), so a single keyword such as React
  cannot make it look strongly aligned — even when that keyword is itself a
  co-requirement. An incidental mention of an unfamiliar technology is never
  penalised, QA/testing/automation roles are treated as transferable-skill
  roles, and a core-dominant mandatory stack ("React, TypeScript and some C#")
  is not penalised at all.
- **A described listing that matches none of the profile's skills is
  penalised.** A bare generic "developer" advert with no demonstrated skill
  overlap (title plus location alone) drops below the alternative bar instead
  of padding the shortlist. Entry-level/graduate/trainee wording, QA/testing
  roles, listings with no description to judge, and confirmed sponsorship
  vacancies are all exempt, so this never rejects a junior role or weakens a
  sponsorship result.
- **Clearly senior titles are excluded from the junior shortlist.**
  `src/services/seniority.ts` filters out Lead, Principal, Staff, Head of
  Engineering, Engineering Manager, Director, C-suite and architect-level roles
  (and plain "Senior/Sr." titles) unless the user explicitly asks for senior
  roles (e.g. `/search senior developers`). The patterns are conservative:
  "Lead Generation Specialist", "Staffing Consultant" or "Head of Sales" are
  never treated as senior engineering titles, and junior, graduate, trainee,
  entry-level and QA/testing roles pass through untouched. Exclusions are
  counted as `senior` in the coverage note.

For a full per-listing audit (which listing was kept/dropped, its score, its
source and URL), set `JOB_SCOUT_DEBUG_DECISIONS=1` and run `/search` once. This
logs one `Job search decision` line per stage — `candidate_*`, `excluded_*`,
`duplicate` (kept vs dropped, with URLs), `shown_*` — and never logs descriptions
or secrets. Leave it unset in normal use.

## Sources

- **Remotive** (`src/services/sources/remotive.ts`) – public, keyless
  `https://remotive.com/api/remote-jobs`. Requests use a 10s timeout and a
  polite minimum interval between calls. The API already provides the full job
  description, so **the source does not scrape employer pages**; doing so would
  be unreliable (pages contain navigation/boilerplate mentioning "sponsorship")
  and could run against anti-bot protections.
- **Adzuna UK** (`src/services/sources/adzuna.ts`) – enabled only when both
  `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` are set. UK-focused and query-aware
  (`what` / `where`), it paginates conservatively (`ADZUNA_MAX_PAGES`, default 2)
  to respect the free-tier rate limits and enforces a 1s minimum interval between
  requests. A half-configured pair is skipped with a warning.

## Known limitations

- A listing that simply does not mention sponsorship stays `unclear`, even if
  the employer *would* sponsor. This is deliberate: absence of evidence is not
  evidence of sponsorship.
- Live Remotive data during development contained **19 listings with usable
  full descriptions; 0 explicitly offered sponsorship; 2 explicitly refused
  it**. No amount of keyword tuning can legitimately turn those into
  `confirmed` results.
- Remotive is global/remote, not UK-only. Region filtering is applied from the
  listing's own location text: explicit UK wording is `eligible`, explicit
  foreign-only wording is `ineligible`, and global/remote wording is `possibly`.
  A listing that names the UK *and* other countries (e.g. "USA, UK, India, …")
  is treated as `possibly` rather than `eligible`, because mentioning the UK
  among many countries does not establish UK eligibility.
- Recruiter detection relies on naming/word signals ("recruitment", "our
  client", …). An agency whose name and wording give no such signal is treated
  as a direct employer; its vacancies still need their own vacancy-level
  evidence before anything is called confirmed.
- Register matching is exact-after-normalisation only. Employers trading under a
  name that differs from their register entry are reported `not_found`, which is
  explicitly *not* a denial.

## Project layout

- `src/bot/` – Telegram bot wiring, auth, router, and handlers (`/search`).
- `src/services/` – search pipeline, deduplication, relevance scoring,
  sponsorship classifier, employer identity resolution, sponsor register, job
  sources, advert-quality filtering (`listingQuality.ts`), application-link
  validation (`applicationUrl.ts`) and seniority eligibility (`seniority.ts`).
- `src/models/` – Zod schemas / types (`Vacancy`, `Profile`).
- `tests/` – Vitest unit tests for the pipeline, sources, classifier, employer
  identity and sponsor register.
