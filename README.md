# Job Scout

**Job Scout** is a private Telegram bot that hunts for UK job vacancies that are
suitable for candidates who require **visa sponsorship**. It searches live job
sources, keeps only vacancies whose own text explicitly offers sponsorship, then
de-duplicates, scores, and ranks them against a personal profile.

The design goal is simple and deliberately strict: **never report a vacancy as
sponsored unless the vacancy itself says so.** Job Scout would rather return
nothing than raise false hopes.

---

## Overview

Finding sponsorship-friendly jobs is hard because most job boards do not expose
whether a role offers a visa. Job Scout solves this by:

1. Pulling vacancies from configured job sources.
2. Verifying sponsorship from the vacancy's own wording.
3. Filtering to **confirmed** sponsorship only (by default).
4. De-duplicating and relevance-scoring the remaining roles.
5. Replying through Telegram with the evidence behind every result.

A vacancy is only ever marked `confirmed` when its title, employer name, or
description contains an explicit positive statement (for example
"we will sponsor", "visa sponsorship available"). Silence is treated as
`unclear`, never as support.

---

## Features

Only features that exist in the current codebase are listed here.

- **Implemented Telegram commands:** `/start`, `/help`, `/status`, `/search`,
  and `/search [n]`.
- **Authorised-user restriction:** every update is checked by middleware; only
  the single configured Telegram user ID can use the bot.
- **Job-source integration:**
  - **Remotive** — enabled. Reads the public, keyless
    `https://remotive.com/api/remote-jobs` endpoint.
  - **Dummy source** — present in the source list but **disabled**
    (`enabled = false`) and skipped by the pipeline.
- **Sponsorship verification:** classifies each vacancy as `confirmed`,
  `unclear`, or `not_offered`, and records the exact evidence sentence plus the
  source URL. Employer sponsor-licence status is tracked **separately**.
- **Deduplication:** removes listings that share an application URL, the same
  employer + title, or the same id; also applies a configured exclusion rule.
- **Relevance scoring:** scores each vacancy 0–100 against a personal profile
  (skills, preferred locations, seniority signals) and sorts highest-first.
- **Diagnostics:** structured logs for each source and a pipeline summary;
  secrets are redacted from all log output.
- **Config validation:** environment variables are validated with Zod at
  startup, with value-free error messages.

> Placeholder services for a future "vacancy verification" and "duplicate
> detection" interface exist in `src/services/`, but they are **not wired into
> the bot** and throw "not implemented". They are not features yet.

---

## Technology stack

| Area           | Technology                                            |
| -------------- | ----------------------------------------------------- |
| Language       | TypeScript (strict)                                   |
| Runtime        | Node.js, native ESM (`"type": "module"`)              |
| Telegram       | [grammY](https://grammy.dev/) (`grammy`)              |
| Validation     | [Zod](https://zod.dev/)                               |
| Config loading | `dotenv`                                              |
| TypeScript dev | `tsx` (run/watch TypeScript directly)                 |
| Testing        | [Vitest](https://vitest.dev/)                         |

Declared dependencies (`package.json`):

- **dependencies:** `dotenv`, `grammy`, `zod`
- **devDependencies:** `@types/node`, `tsx`, `typescript`, `vitest`

---

## Prerequisites

- **Node.js 20 or newer** (LTS recommended). The project targets ES2022 and
  uses modern ESM; no `engines` field is declared, but the dev tooling
  (Vitest 5, `tsx`) requires a current Node runtime.
- **npm** (bundled with Node.js).
- **Git** (to clone the repository).
- A **Telegram account**.
- A **Telegram bot** created through [@BotFather](https://t.me/BotFather).

---

## Local installation

Run these PowerShell commands from the location where you keep your projects.
Replace `<your-repository-url>` with the actual repository URL.

```powershell
git clone <your-repository-url>
cd job-scout
npm install
Copy-Item .env.example .env
```

Open `.env` and fill in the two values (see
[Environment configuration](#environment-configuration)), then start the bot:

```powershell
npm run dev
```

`npm run dev` starts `tsx watch src/index.ts` and restarts on file changes.
Press `Ctrl+C` to stop it.

---

## Environment configuration

The source of truth is [`.env.example`](.env.example). Copy it to `.env` and set
the values:

| Variable                   | Required | Description                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | Yes      | Bot token from BotFather. Format: `<digits>:<letters/underscores>`. |
| `TELEGRAM_ALLOWED_USER_ID` | Yes      | Numeric Telegram user ID allowed to use the bot.                 |

Validation rules (`src/config/env.ts`):

- `TELEGRAM_BOT_TOKEN` must be non-empty and match `^\d+:[A-Za-z0-9_-]+$`.
- `TELEGRAM_ALLOWED_USER_ID` must be a positive integer (stored as a number).

If configuration is invalid the bot prints a value-free error (it never echoes
the received token) and exits with a non-zero code.

**Getting a bot token:** message [@BotFather](https://t.me/BotFather), send
`/newbot`, follow the prompts, and copy the token it returns.

**Finding your user ID:** message [@userinfobot](https://t.me/userinfobot); it
replies with your numeric Telegram user ID.

> Never commit `.env` and never paste real credentials into issues, logs, or
> source files.

---

## Available commands

| Command        | Description                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `/start`       | Short introduction.                                                    |
| `/help`        | Lists the available commands.                                          |
| `/status`      | Shows bot state, the current phase, and the authorised user ID.        |
| `/search`      | Searches sources and returns up to the default number of results.      |
| `/search [n]`  | Searches and returns up to `n` results (maximum 10).                   |

`/search [n]` details (`src/bot/handlers/search.ts`):

- The first argument must be a positive integer.
- Invalid input replies with `Invalid number. Usage: /search [number]`.
- The result count is capped at **10** (`MAX_RESULTS`).
- Without an argument the handler requests **5** results.
- Replies are sent as MarkdownV2 and truncated if they would exceed 4,000
  characters.

Non-command text is ignored. Unrecognised slash commands receive a short
"unknown command" reply.

---

## Job-search and sponsorship rules

**An employer holding a sponsor licence does NOT prove that an individual
vacancy offers sponsorship.** Many licensed employers still do not sponsor every
role. Job Scout therefore keeps licence status and vacancy-level evidence
completely separate.

`classifySponsorship()` (`src/services/sponsorship.ts`) evaluates the vacancy's
title, employer name, and description in this order:

1. **Licence scan** — records `employerSponsorLicence` as `yes` / `no` /
   `unknown`. This **never** changes the vacancy status.
2. **Explicit refusal scan** — phrases such as "unable to sponsor",
   "no visa sponsorship", "do not provide visa assistance" →
   **`not_offered`**.
3. **Explicit support scan** — phrases such as "visa sponsorship",
   "will sponsor", "able to sponsor", "sponsorship available" →
   **`confirmed`**.
4. **Otherwise** → **`unclear`** (silence is never treated as support).

How the three outcomes are handled:

| Status        | Meaning                                             | Returned by `/search`? |
| ------------- | --------------------------------------------------- | ---------------------- |
| `confirmed`   | Explicit, quoted sponsorship evidence in the listing. | Yes                    |
| `unclear`     | No explicit evidence either way.                    | No (excluded)          |
| `not_offered` | Explicit statement that sponsorship is not offered. | No (excluded)          |

The stored `sponsorshipEvidence` quotes the **exact sentence** containing the
match and the **source URL**, so a human can re-check it. The pipeline also
exposes an `includeUnclear` option internally, but the Telegram command does
**not** enable it — `/search` is confirmed-only.

---

## Job sources and limitations

### Remotive (enabled)

- **Access:** HTTP GET to `https://remotive.com/api/remote-jobs`, no API key.
- **Processing:** records are capped at 100, HTML is stripped from the
  description, and each record is validated before use. Malformed records are
  rejected and counted (for example `missing_or_invalid_url`, `missing_title`,
  `missing_employer`, `schema`).
- **Etiquette:** requests use a **10-second timeout** and a **minimum interval
  of 1 second** between calls.
- **Limitations:**
  - The API is **global/remote**, not UK-specific, and region filtering is not
    applied yet.
  - It ignores the `keywords`, `location`, and `limit` query parameters, so it
    effectively returns the same set of listings each time.
  - Description content is what determines classification, so listings that do
    not mention sponsorship stay `unclear`.
- **Page scraping:** none. The API already provides the full description, so
  **no employer pages are fetched**. Scraping them would be unreliable (their
  pages contain navigation/boilerplate mentioning "sponsorship") and could
  conflict with anti-bot protections.

### Dummy source (disabled)

`src/services/sources/dummy.ts` implements the `JobSource` interface but returns
nothing and is `enabled = false`, so the pipeline skips it.

### Source failures

Each source call is wrapped in error handling. On failure the source is skipped,
the error is recorded as `"<source>: <message>"`, and a warning is logged. The
`/search` reply:

- appends a note when some sources were unavailable, and
- replies `Could not reach any job sources. Please try again later.` when **no**
  source could be reached at all.

> Verified during development against live Remotive data: 19 listings were
> returned, all with usable descriptions, **0** were `confirmed`, and **2** were
> explicit refusals (`not_offered`). This is expected behaviour, not a bug.

---

## Testing and development

Commands defined in `package.json`:

```powershell
npm run dev         # tsx watch src/index.ts  (development server)
npm start           # tsx src/index.ts        (run once)
npm run build       # tsc -p tsconfig.build.json  (emit to dist/)
npm run typecheck   # tsc --noEmit            (type-check only)
npm test            # vitest run              (run the test suite once)
npm run test:watch  # vitest                  (watch mode)
```

Tests live under `tests/` and run in the Node environment (see
`vitest.config.ts`). At the time of writing the suite has **10 test files and 73
passing tests** covering the command router, handlers, configuration, the search
pipeline, sponsorship classification, and the Remotive source.

---

## Security

- **`.env` is git-ignored** (`.gitignore` excludes `.env` and `.env.*`, while
  keeping `.env.example`). Never commit real credentials.
- **Secrets are redacted from logs.** `createLogger` replaces the configured
  secrets with `[REDACTED]` in every message and detail payload, and
  `redactSecrets` is also used when reporting fatal startup errors.
- **Configuration errors are value-free.** Validation messages never include the
  received token.
- **Single-user access.** The auth middleware drops every update that is not
  from `TELEGRAM_ALLOWED_USER_ID`; other users get a generic "private bot"
  message and never reach a handler.

---

## Deployment

`npm run dev` and `npm start` are intended for **local development and personal
use**. There is currently no production deployment configuration:

- `npm start` runs the TypeScript directly with `tsx`. Although `npm run build`
  emits JavaScript to `dist/`, there is no npm script that runs the compiled
  output.
- An always-on bot needs a suitable host (for example a small VPS or container
  running `npm start` under a process manager) or an adapted serverless/webhook
  architecture, which is not implemented here.
- The bot is **not** deployed by this repository.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| ------- | -------------------- |
| Bot replies "This is a private bot…" | Your Telegram user ID does not match `TELEGRAM_ALLOWED_USER_ID`. Check the ID via [@userinfobot](https://t.me/userinfobot). |
| Startup fails with `Invalid environment configuration` | `.env` is missing or malformed. Confirm `TELEGRAM_BOT_TOKEN` matches `<digits>:<token>` and `TELEGRAM_ALLOWED_USER_ID` is a positive integer. |
| `TELEGRAM_BOT_TOKEN has an invalid format` | The token was copied incorrectly or `.env` is not loaded (run from the project root). |
| `/search` says no listings were found | The source returned nothing, or returned only records that failed validation. Retry later. |
| `/search` says "Could not reach any job sources" | A network problem or a source outage. Check connectivity and try again later. |
| `/search` returns zero confirmed results | Working as designed: listings were found but none contained explicit sponsorship evidence. They are excluded as `unclear` or `not_offered`. |
| `/search 20` seems capped | The handler caps results at 10 (`MAX_RESULTS`). |

---

## Roadmap

Ideas that are **not yet implemented**:

- Scheduled / automatic sponsorship alerts pushed to Telegram.
- Additional **verified** job sources (only sources actually tested should be
  added).
- Wiring the placeholder vacancy-verification service into the pipeline.
- UK/region and remote-eligibility filtering.
- A user-editable profile instead of the hard-coded personal profile.
- Optional "show unclear results" mode surfaced through the bot.

---

## Licence

No `LICENSE` file is included in this repository, so no licence text has been
specified yet. `package.json` currently declares `"license": "ISC"`, but this has
not been accompanied by a licence file. Add a `LICENSE` file (and align the
`package.json` field) before publishing if you intend to license the project.
