# TestFlight Feedback MCP Server — Design

**Date:** 2026-07-03
**Status:** Approved for implementation (spec fully provided by user; autonomous session)

## Goal

An MCP server that lets Claude Code (or any MCP host) read, analyze, prioritize, and act on
TestFlight beta feedback from App Store Connect — feedback → AI analysis → code changes without
leaving the IDE.

## Foundations

Built on [krishnal/mcp-server-boilerplate](https://github.com/krishnal/mcp-server-boilerplate):
hand-rolled transport-agnostic MCP core (spec `2025-06-18`), stdio/HTTP/Lambda adapters,
declarative `defineTool/Resource/Prompt` capabilities, composition-root DI, Zod-validated env
config, Pino/Prometheus/OTel observability. The protocol core is kept intact with **one**
deliberate extension: `CapabilityContext` gains a typed `services` bag (ASC client, store,
analyzer, issue providers) wired in the composition root, so handlers stay pure
`(input, ctx) → result` functions and tests inject fakes.

## Upstream API (decision: official, stable endpoints only)

Uses the **official App Store Connect API 4.0 beta-feedback resources** (WWDC 2025; stable,
documented) — not the legacy undocumented `iris` API:

- `GET /v1/apps` — resolve app by bundle ID / list apps
- `GET /v1/apps/{id}/betaFeedbackScreenshotSubmissions` — filters: `appPlatform`, `build`,
  `build.preReleaseVersion`, `deviceModel`, `devicePlatform`, `osVersion`, `tester`;
  `sort=(-)createdDate`; `include=build,tester`; `limit≤200`, JSON:API cursor pagination
- `GET /v1/apps/{id}/betaFeedbackCrashSubmissions` — same shape
- `GET|DELETE /v1/betaFeedback{Screenshot,Crash}Submissions/{id}`
- `GET /v1/betaFeedbackCrashSubmissions/{id}/crashLog` → `logText`

Key attribute facts that shape the design:
- Screenshot submissions carry `screenshots: [{url, expirationDate, width, height}]` — **signed,
  expiring URLs**, hence the local download tool and path persistence.
- Rich device context (deviceModel, osVersion, locale, battery, disk, connectionType,
  appUptimeInMilliseconds, …) — surfaced verbatim to the model for analysis.
- Apple's API has **no read/processed concept** — processed state is purely local.

## Authentication

- ES256 JWT signed with the `.p8` key via `jose` (already a boilerplate dep).
  Claims: `iss` = Issuer ID, `kid` = Key ID (header), `aud=appstoreconnect-v1`, `exp` = now+15 min.
- Key sourcing: `ASC_PRIVATE_KEY_BASE64` **or** `ASC_PRIVATE_KEY_PATH` (validated at boot;
  exactly one required). Key material never logged; pino redaction extended.
- `TokenProvider` caches the token and mints a new one when <2 min of life remain; a 401 from
  the API forces one refresh+retry.

## Architecture

```
src/
├── asc/            # App Store Connect: token-provider.ts, client.ts, types.ts
├── storage/        # node:sqlite FeedbackStore (schema.ts, feedback-store.ts)
├── analysis/       # analyzer.ts (Claude API, optional), similarity.ts, prioritize.ts, todo.ts
├── issues/         # IssueProvider interface + github.ts / jira.ts / linear.ts
├── capabilities/   # MCP tools/resources/prompts (thin: parse → services → format)
└── core|adapters|auth|config|observability  # boilerplate (config extended; ctx.services added)
```

Layering: capabilities never touch HTTP/SQL directly; `asc/` never touches SQLite; `analysis/`
and `issues/` depend only on plain domain types (`storage/` + `asc/types`).

### Storage (decision: `node:sqlite`, not better-sqlite3)

The boilerplate already requires Node ≥ 24, where the built-in `node:sqlite` (`DatabaseSync`)
offers the same synchronous API as better-sqlite3 with **zero native compilation** — it survives
esbuild single-file Lambda bundling and slim Docker images untouched. Swappable via the
`FeedbackStore` interface if drizzle/libsql is ever wanted.

Tables (`STATE_DB_PATH`, default `./data/testflight.db`; WAL mode):
- `feedback` — id PK, kind (screenshot|crash), app_id, comment, build/version/device columns,
  created_date, `raw_json` (full ASC payload cache → duplicates/prioritize work offline),
  processed, processed_at, processed_note, timestamps
- `screenshots` — (feedback_id, idx) PK, local_path, width/height, downloaded_at
- `analyses` — feedback_id PK, JSON (screen, problem, component, severity, confidence,
  suggested_fix), source (`api`|`host`), model, created_at
- `todos` — feedback_id PK, markdown, created_at
- `duplicate_groups` — (group_id, feedback_id) PK, similarity
- `issues` — (feedback_id, provider) PK, issue_key, issue_url, created_at → **idempotency**

### AI analysis (decision: host-delegated by default, API-autonomous optional)

The MCP host *is* a vision model, so the default `analyze_feedback` needs no API key: it returns
the screenshot(s) as MCP image content blocks + device context + a structured-analysis
instruction; the host performs the vision analysis and persists it via `save_analysis`.
If `ANTHROPIC_API_KEY` is configured, `analyze_feedback` instead calls Claude
(`claude-sonnet-5`, vision + tool-forced JSON) directly and persists the result itself.
Same stored shape either way.

### Duplicates & prioritization (deterministic v1)

- `group_duplicates`: lexical similarity over normalized comments (token Jaccard + character
  bigram Dice, averaged), boosted when build/deviceModel/analysis-screen match; greedy
  clustering above a threshold (default 0.55). No embedding/network dependency.
- `prioritize_feedback`: score = severity (stored analysis, else crash=high) + group frequency
  + recency decay; returns ranked groups with reasons. Pure function, unit-tested.

### Issue providers

`IssueProvider.create(payload) → {key, url}` with GitHub (REST), Jira (REST v3, ADF body),
Linear (GraphQL). Config-gated (only configured providers are offered), idempotent (existing
`issues` row → return existing link, no duplicate). Issue body includes comment, device/build
context, stored analysis, TODO checklist, and screenshot paths.

## MCP surface

Tools (all with Zod schemas, `isError` business failures; per-tool scopes deliberately omitted
in v1 for stdio DX — the boilerplate's `requiredScopes` hook is the extension point):
`list_apps`, `list_feedback`, `get_feedback`, `get_crash_log`, `download_screenshot`,
`mark_processed`, `mark_unprocessed`, `list_unprocessed`, `analyze_feedback`, `save_analysis`,
`generate_todo`, `prioritize_feedback`, `group_duplicates`, `create_issue`.

Resources: `feedback://{id}` (JSON, from local cache→API). Prompt: `triage-feedback` (guided
end-to-end workflow).

## Error handling

- ASC errors → typed `AscApiError` (status, JSON:API detail) → `isError` text results the LLM
  can act on (e.g. "screenshot URL expired — re-fetch feedback", 429 retry-after honored with
  bounded retry, 401 → single token refresh).
- Expired screenshot URLs: on download failure with 403/410, re-fetch the submission once for
  fresh URLs.
- All handlers honor `ctx.signal`.

## Testing

Vitest. Unit: token provider (fake clock), ASC client (undici `MockAgent`: pagination, 429,
401-refresh), store (`:memory:`), similarity/prioritize/todo (pure), providers (mocked HTTP).
Protocol: boilerplate `mcp-test-client` drives real dispatcher with fake services injected via
the container. Boilerplate's existing suite stays green.

## Deployment

stdio (primary, Claude Code/Desktop), Docker (HTTP), Lambda (works — `node:sqlite` bundles
cleanly; state on `/tmp` is ephemeral per container: document EFS or container deploy for
durable state).

## Out of scope (v1)

Polling/webhooks, embeddings-based clustering, crash-log symbolication, issue-status sync-back.
Extension points documented in README.
