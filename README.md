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

- **Node.js 20 or newer** (LTS recommended). The project targets ES2022, uses
  modern ESM, and declares `"engines": { "node": ">=20" }` in `package.json`
  (matching the minimum Vercel expects).
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

Open `.env` and fill in the required values (see
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

| Variable                   | Required            | Description                                                                 |
| -------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | Yes\*               | Bot token from BotFather. Format: `<digits>:<letters/underscores>`.          |
| `TELEGRAM_ALLOWED_USER_ID` | Yes                 | Numeric Telegram user ID allowed to use the bot.                            |
| `BOT_TOKEN`                | Alias for the token | Alternative name for `TELEGRAM_BOT_TOKEN`, convenient on Vercel.            |
| `TELEGRAM_WEBHOOK_SECRET`  | Webhook mode        | 1–256 chars of `A-Z a-z 0-9 _ -`; required when running via webhooks.       |
| `TELEGRAM_WEBHOOK_URL`     | Optional            | Public deployment base URL, used by `npm run set-webhook`.                  |

\* Provide **either** `TELEGRAM_BOT_TOKEN` **or** `BOT_TOKEN`. If both are set,
`TELEGRAM_BOT_TOKEN` wins. Neither is required for long polling to start if the
other is present.

Validation rules (`src/config/env.ts`):

- The Telegram token must be non-empty and match `^\d+:[A-Za-z0-9_-]+$`.
- `TELEGRAM_ALLOWED_USER_ID` must be a positive integer (stored as a number).
- `TELEGRAM_WEBHOOK_SECRET` must match `^[A-Za-z0-9_-]{1,256}$`.
- `TELEGRAM_WEBHOOK_URL` must be a valid URL.

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
npm run dev            # tsx watch src/index.ts  (development server, long polling)
npm start              # tsx src/index.ts        (run once, long polling)
npm run build          # tsc -p tsconfig.build.json  (emit to dist/)
npm run typecheck      # tsc --noEmit            (type-check only)
npm test               # vitest run              (run the test suite once)
npm run test:watch     # vitest                  (watch mode)
npm run set-webhook    # tsx src/scripts/setWebhook.ts          (register webhook)
npm run delete-webhook # tsx src/scripts/setWebhook.ts delete   (back to polling)
```

Tests live under `tests/` and run in the Node environment (see
`vitest.config.ts`). At the time of writing the suite has **12 test files and 89
passing tests** covering the command router, handlers, configuration (including
webhook settings), the webhook handler itself, the search pipeline, sponsorship
classification, and the Remotive source.

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

The bot supports two mutually exclusive run modes. **Never run them at the same
time** — Telegram delivers each update once, and grammY itself refuses to start
long polling on a bot instance that already serves a webhook.

| Mode            | Entry point                        | Use case                          |
| --------------- | ---------------------------------- | --------------------------------- |
| Long polling    | `src/index.ts` (`npm run dev`)     | Local development and personal use. |
| Webhooks        | `api/webhook.ts` (Vercel function) | Production on Vercel.             |

### Running locally with long polling

`npm run dev` (or `npm start`) runs `tsx src/index.ts` and calls `bot.start()`,
which polls Telegram. No `TELEGRAM_WEBHOOK_SECRET` is needed. If you have already
registered a webhook, remove it first with `npm run delete-webhook`.

### Deploying to Vercel with webhooks

Vercel runs the bot as a single serverless function instead of an always-on
process:

- `api/webhook.ts` is a Vercel Function: any file under `api/` is deployed as a
  function and served at the path **without** its extension —
  `https://<project>.vercel.app/api/webhook`. It loads and validates the
  environment, builds the bot once per warm instance, and exports grammY's
  HTTPS webhook handler as the default export.
- `vercel.json` only sets `"outputDirectory": "dist"` (the compiled output of
  `npm run build`), so Vercel has a valid output directory and the
  `No Output Directory named "public"` error cannot occur. There are **no
  legacy `builds`/`routes`**, so nothing rewrites or bypasses the
  `/api/webhook` function.
- `src/bot/webhook.ts` wraps `webhookCallback(bot, "https", { secretToken })`.
  grammY compares the incoming `X-Telegram-Bot-Api-Secret-Token` header against
  `TELEGRAM_WEBHOOK_SECRET` in constant time and answers mismatches with HTTP
  **401**. The secret is mandatory, so the endpoint cannot be driven by anyone
  who does not know it.

**Steps:**

1. Push the repository to GitHub and import it at
   [vercel.com/new](https://vercel.com/new). The framework preset can stay
   "Other"; `vercel.json` supplies the build and routing.
2. In **Project → Settings → Environment Variables**, add:
   - `BOT_TOKEN` — your bot token (or `TELEGRAM_BOT_TOKEN`).
   - `TELEGRAM_ALLOWED_USER_ID` — your numeric Telegram user ID.
   - `TELEGRAM_WEBHOOK_SECRET` — a random 1–256 char secret (letters, digits,
     `_`, `-`). Generate one with the PowerShell snippet below.
   - `TELEGRAM_WEBHOOK_URL` — your deployment URL, e.g.
     `https://<project>.vercel.app`. Optional: the setup script falls back to
     Vercel's own `VERCEL_URL`.
3. Deploy. The function is then live at
   `https://<project>.vercel.app/api/webhook`.
4. Register the webhook with Telegram (run locally against the same variables):

   ```powershell
   npm run set-webhook
   ```

   This calls `setWebhook` with the secret token and `allowed_updates`, then
   prints `getWebhookInfo` so you can confirm the URL and pending updates.
5. To go back to local polling, run `npm run delete-webhook` and start
   `npm run dev`.

Generate a secret:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
```

**Verifying the deployed route before testing in Telegram:**

```powershell
curl.exe -X POST "https://<project>.vercel.app/api/webhook" -H "content-type: application/json" -d "{\"update_id\":0}"
```

A `401 Unauthorized` (anything except `404 Not Found`) means the function is
live at the registered URL and is only rejecting requests that lack the correct
`X-Telegram-Bot-Api-Secret-Token` header. Then confirm Telegram sees no errors
by running `npm run set-webhook`, which re-registers the webhook (idempotent)
and prints `getWebhookInfo`; `last_error_message` should be empty or absent.

> The webhook URL must be **HTTPS**; Telegram only calls secure endpoints.
> Telegram retries failed deliveries, so a cold-starting Vercel function is fine.

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
| Vercel build fails with `No Output Directory named "public"` | `vercel.json` must exist with `"outputDirectory": "dist"` and `npm run build` must emit `dist/` (run it locally first). |
| Webhook endpoint always answers `401` | The `X-Telegram-Bot-Api-Secret-Token` header does not match `TELEGRAM_WEBHOOK_SECRET`. Re-run `npm run set-webhook` after changing the secret. |
| Messages silently do nothing on Vercel | The webhook is not registered, or points at the wrong URL. Run `getWebhookInfo` (via `npm run set-webhook`) and check `last_error_message`. |
| Telegram reports `Conflict: terminated by other getUpdates` | Long polling and the webhook are running at the same time. Run `npm run delete-webhook` before `npm run dev`. |

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
