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
| `/status` | Show bot status, schedule, next run, last run and alert state. |
| `/search` | Search sources, returning confirmed-sponsorship vacancies first and up to five clearly-labelled unconfirmed alternatives. |
| `/schedule` | Show and change the daily automatic search (see "Scheduled searches"). |
| `/pause`  | Temporarily pause automatic alerts (searches may still run).  |
| `/resume` | Resume automatic alerts.                                      |
| `/save`   | Save the vacancy from the message you just received (kept through `/empty`). |
| `/saved`  | List the vacancies you have saved.                            |
| `/empty`  | Clear this chat of messages the bot is allowed to delete; saved vacancy messages are kept. |

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` – from [@BotFather](https://t.me/BotFather)
   - `TELEGRAM_ALLOWED_USER_ID` - your numeric id from [@userinfobot](https://t.me/userinfobot)
   - *(optional)* `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` - enables the UK Adzuna source
   - *(optional)* `UK_SPONSOR_REGISTER_URL` - enables employer sponsor-register checks (see below)
   - *(optional)* `JOB_SCOUT_DEBUG_DECISIONS` - per-listing audit log for diagnosing result counts
   - *(optional)* `JOB_SCOUT_SCHEDULE_TIME` / `JOB_SCOUT_TIMEZONE` / `JOB_SCOUT_MAX_NOTIFICATIONS` / `JOB_SCOUT_STATE_DIR` - Phase 3 scheduling defaults (see below)
   - *(production only)* `CRON_SECRET` - shared secret for the scheduled-search
     endpoint (Vercel Cron sends it automatically)
   - *(production only)* `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` -
     durable state on serverless (see Persistence below)
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

## Scheduled searches, notifications and `/empty` (Phase 3)

### Daily automatic searches

The bot can run the exact same pipeline as `/search` automatically once a day
(`src/services/scheduling/scheduler.ts`, `searchRunner.ts`). The default is
08:00 in `Europe/London`, enabled on first start; every value is configurable:

```
/schedule                   show current schedule and options
/schedule on                enable automatic searches
/schedule off               disable automatic searches (settings are kept)
/schedule time 07:30        set the daily time (24-hour HH:MM)
/schedule timezone Europe/London   set the IANA timezone
```

State is kept separate on purpose:

| Command   | Effect                                        |
| --------- | --------------------------------------------- |
| `/schedule off` | Stops the daily search entirely.        |
| `/pause`  | Searches may still run, but **no alerts are sent**; new jobs stay queued and are delivered on `/resume`. |
| `/resume` | Alerts resume, and anything queued while paused is delivered. |

- Timezone arithmetic uses the platform `Intl` API (no dependency), so DST
  transitions are handled correctly.
- Runs cannot overlap: the scheduler keeps an in-memory lock and a persisted
  `lastRun` marker, so a restart or a slow run never fires a double batch.
- After a restart the scheduler resumes: an interrupted run is marked failed,
  pending notifications are retried, and one missed run is caught up.
- The scheduled search goes through the shared `RealJobSearchService` pipeline
  (relevance scoring, UK eligibility, sponsorship classifier, employer-register
  safeguards, deduplication, paid-training and seniority filters, apply-link
  validation), so it can never produce results `/search` would not.
- A short in-process cache (10 minutes) means an identical retried query does
  not hit Adzuna/Remotive twice; the existing per-source rate limits are
  unchanged.

### What triggers an alert

Alerts are only sent for **newly discovered** jobs, never for every listing a
run returns. Each vacancy is fingerprinted three ways (canonical URL, source id,
and normalised employer+title+location), and all three are persisted
(`src/services/scheduling/jobIdentity.ts`), so:

- the same vacancy re-appearing on a second source is not alerted twice;
- a repost of the same employer/title/location is not alerted twice;
- restarting the bot cannot replay a batch.

Confirmed vacancy-specific sponsorship is prioritised first, then relevant
UK-eligible alternatives above the relevance floor, clearly labelled
"sponsorship unconfirmed". A verified sponsor-register entry is reported as a
separate capability line and never upgrades a vacancy to confirmed, exactly as
in `/search`.

Per run a maximum of 5 notifications is sent (configurable with
`JOB_SCOUT_MAX_NOTIFICATIONS`); extra matches are marked seen and summarised
with a pointer to `/search`. Delivery is durable: discovery is written to disk
*before* any message is sent, and failed deliveries stay in a pending queue with
their attempt count and error. A crash between discovery and delivery therefore
cannot lose an alert, and an undelivered alert is never recorded as delivered.

### Saved vacancies (`/save`, `/saved`)

`/save` keeps a vacancy (and the Telegram message it arrived in) so `/empty`
cannot delete it:

- `/save` saves the vacancy from the most recent vacancy message. Because the
  notifier sends one message per job, this is "the job I just received".
- `/save <number>` picks one when a single message (such as a `/search` digest)
  contained several.
- Replying `/save` to a specific vacancy message saves from that message.

Saved records live in their own part of the state document, outside the tracked
conversation, so they survive restarts and `/empty`. Each record remembers the
Telegram message id it came from; `/empty` never attempts that message. If the
saved message is already older than Telegram's 48-hour deletion window, the
record is still kept and the report says so. `/saved` lists what you have saved.

### `/empty` and Telegram's real deletion limits

Telegram's API has **no "clear chat history" call**. A bot can only delete a
message when it knows the message id, and only within 48 hours of sending.
`/empty` therefore:

- tracks the ids of the bot's own outgoing messages (via an API transformer)
  and the authorised user's incoming private-chat messages;
- deletes every tracked message in that exact chat, skipping anything older
  than 48 hours without pretending;
- **never deletes a message carrying a saved vacancy** (see `/save` above), at
  any age, and never touches the saved records themselves;
- reports truthful counts - messages deleted, saved messages preserved, and
  messages that could not be deleted (with the reason) - and suggests
  Telegram's own "Clear history" as the practical fallback;
- never deletes its own confirmation (it is sent after the cleanup);
- never touches schedule settings, seen-job history, the notification queue or
  any other persistent data.

Older history that predates tracking is not reachable by a bot at all, which is
why a fresh install of `/empty` only covers messages seen since this version ran
(`src/services/conversation/`).

**True full-history deletion needs MTProto.** The Bot HTTP API cannot enumerate
a chat's history or delete messages it never saw, so neither the bot nor this
`/empty` can remove the entire conversation. Deleting *all* historical messages
(both sides) would require a separate MTProto client acting as your personal
Telegram account (an `api_id`/`api_hash` and a signed-in user session), which has
full account access and is deliberately **not** implemented. For a complete wipe,
use Telegram's own "Clear history" in the chat menu, which removes both sides.

### Persistence

All Phase 3 state lives in one JSON document
(`src/services/state/stateStore.ts`): schedule settings, `nextRunAt`, recent
runs, seen-job identifiers, the pending-notification queue, per-chat message
ids, saved vacancies and the small `/save` lookup index. Writes are atomic and
serialised, reads validate the whole document, and corrupt data is backed up
and replaced with defaults so startup never fails. New sections added after v1
default to empty, so an existing document keeps loading unchanged. No secrets
are stored in it.

Three backends implement the same `StateStore` contract
(`src/services/state/`):

- **file** (default locally): `./data/job-scout-state.json`, relocatable with
  `JOB_SCOUT_STATE_DIR`; atomic temp-file + rename.
- **upstash**: the same document in a free [Upstash](https://upstash.com) Redis
  database, reached over its REST API with `fetch` (no npm dependency). This is
  required on Vercel, where there is no persistent disk and the file fallback
  would land in the per-instance, ephemeral `/tmp`. Set
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (used automatically
  when both are present) or force it with `JOB_SCOUT_STATE_BACKEND=upstash`. It
  also grants an atomic lock so overlapping serverless invocations cannot run
  the same search twice.
- **memory**: `JOB_SCOUT_STATE_BACKEND=memory`; nothing is persisted (tests or
  throwaway runs only).

### Automatic searches in production (webhook/serverless)

In webhook mode the bot never long-polls and no in-process timer runs, so the
daily search is driven from outside by a protected endpoint:

- `GET/POST /api/scheduled-search` runs the search **only when it is due**
  (`Scheduler.runIfDue`). Due-ness comes from the persisted `nextRunAt`, which is
  computed with `Intl` in the configured IANA timezone, so daylight-saving
  changes are handled by the runtime's tz database rather than by the trigger's
  wall clock. Repeated or overlapping triggers cannot double-alert: the
  seen-set de-duplicates discoveries and the completion notice is bound to the
  run's slot. `/schedule off` and `/pause` are respected.
- The endpoint requires `Authorization: Bearer <CRON_SECRET>` (constant-time
  comparison, never logged). Vercel Cron sends this header automatically once
  `CRON_SECRET` is set in the project environment.
- `vercel.json` invokes the endpoint twice a day (07:00 and 08:00 UTC) so the
  default 08:00 `Europe/London` schedule is covered in both BST and GMT. Vercel
  **Hobby** can only run a cron job once per day and may fire anywhere within the
  specified hour, so a run can start up to about an hour late. For exact timing,
  either upgrade to Pro and replace the entries with a frequent expression
  (for example `*/5 * * * *`), or point any external scheduler (GitHub Actions,
  cron-job.org, ...) at the same URL every 15-60 minutes. Extra triggers are
  harmless because the endpoint is idempotent.
- The scheduled-search function requests `maxDuration: 60s`. With Fluid Compute
  (on by default) Hobby allows up to 300s, so a slow sponsor-register download
  is not cut off mid-run.


## Known limitations

- **Serverless scheduling needs the Upstash backend.** On Vercel the file
  fallback lands in `/tmp`, which is per-instance and ephemeral, so without
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` the seen-set, `nextRunAt`,
  saved vacancies and pending queue can be lost between cold starts (risking
  duplicate alerts). With Upstash configured the document is durable and the
  scheduled search takes an atomic lock. Local runs (`npm run dev`) are
  unaffected.
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

- `src/bot/` - Telegram bot wiring, auth, router, handlers (`/search`,
  `/schedule`, `/pause`, `/resume`, `/save`, `/saved`, `/empty`), the shared
  vacancy-card formatter (`vacancyCard.ts`) and the Phase 3 service bundle
  (`services.ts`).
- `src/services/` - search pipeline, deduplication, relevance scoring,
  sponsorship classifier, employer identity resolution, sponsor register, job
  sources, advert-quality filtering (`listingQuality.ts`), application-link
  validation (`applicationUrl.ts`), seniority eligibility (`seniority.ts`) and
  saved vacancies / the `/save` index (`savedVacancies.ts`).
- `src/services/state/` - the state document and its stores: file (atomic
  writes), Upstash Redis (durable, cross-instance lock) and in-memory, plus the
  backend resolver.
- `src/services/scheduling/` - schedule/timezone arithmetic, `scheduler.ts`,
  `searchRunner.ts` (cached pipeline), `notifications.ts` (seen-set, pending
  queue, delivery), `jobIdentity.ts` (stable job fingerprints).
- `src/services/conversation/` - message-id tracking and `/empty` cleanup.
- `src/models/` - Zod schemas / types (`Vacancy`, `Profile`).
- `api/` - Vercel Serverless Function entry points: the Telegram webhook
  (`api/webhook.ts`) and the protected scheduled-search trigger
  (`api/scheduled-search.ts`).
- `tests/` - Vitest unit tests for the pipeline, sources, classifier, employer
  identity, sponsor register, scheduler, notifications, saved vacancies,
  `/empty` and stores.
