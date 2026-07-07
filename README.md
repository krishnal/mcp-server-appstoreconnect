# mcp-server-appstoreconnect

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude Code (or any MCP host) to your **TestFlight beta feedback** in App Store Connect — so tester feedback flows straight into an AI-assisted workflow: *fetch → analyze screenshots → prioritize → generate TODOs → file issues → fix the code* without leaving the IDE.

Built on [krishnal/mcp-server-boilerplate](https://github.com/krishnal/mcp-server-boilerplate): transport-agnostic MCP core (spec `2025-06-18`), stdio/HTTP/Lambda adapters, Zod-validated config, Pino/Prometheus/OTel observability, pluggable auth.

- **Upstream API**: the official, stable **App Store Connect API 4.0** beta-feedback endpoints (`betaFeedbackScreenshotSubmissions`, `betaFeedbackCrashSubmissions`, crash logs) — no private/undocumented APIs
- **Local state**: SQLite via Node's built-in `node:sqlite` — zero native dependencies, works everywhere including Lambda bundles
- **AI analysis**: dual-mode — the MCP host model (Claude) analyzes screenshots by default with **zero extra configuration**, or set `ANTHROPIC_API_KEY` and the server analyzes autonomously
- **Integrations**: file issues into GitHub, Jira, or Linear with full context, idempotently

## Tools

| Tool | What it does |
|---|---|
| `list_apps` | Resolve App Store Connect app ids (feeds `ASC_APP_ID`) |
| `list_feedback` | List screenshot/crash feedback with filters (build, version, device, OS, platform, date range, processed state) |
| `get_feedback` | Full detail: comment, device/build context, screenshots, analysis, TODO, linked issues, processed state |
| `get_crash_log` | Crash log text for a crash submission |
| `download_screenshot` | Download screenshots to `~/.mcp-server-appstoreconnect/screenshots/<id>/` (signed URLs expire — expiry is handled) and embed them for immediate visual analysis |
| `list_unprocessed` | The triage queue — everything not yet marked processed |
| `mark_processed` / `mark_unprocessed` | Local processed state, with an optional resolution note |
| `analyze_feedback` | Structured analysis (screen, problem, component, severity, confidence, fix approach) — autonomous with `ANTHROPIC_API_KEY`, otherwise hands evidence to the host model |
| `save_analysis` | Persist a host-performed analysis (the other half of the dual mode) |
| `generate_todo` | Actionable engineering checklist (reproduce → root-cause → fix → test → verify → close) |
| `group_duplicates` | Cluster similar feedback (lexical similarity + build/device/screen signals) |
| `prioritize_feedback` | Rank by severity × duplicate frequency × recency, with human-readable reasons |
| `create_issue` | File a GitHub/Jira/Linear issue with comment, context, analysis, TODO, screenshot paths — idempotent per feedback+provider |

Plus a `feedback://{id}` **resource template** (attach feedback to conversations) and a `triage_feedback` **prompt** (guided end-to-end triage workflow).

## Getting started

### 1. Create an App Store Connect API key

1. App Store Connect → **Users and Access → Integrations → App Store Connect API → Team Keys → “+”**.
2. Role: **Developer** (or App Manager). Beta-feedback endpoints require Admin, App Manager, or Developer.
3. Note the **Issuer ID** (top of the page) and the key's **Key ID**, and download the **`.p8` file** — Apple lets you download it exactly once.

You'll pass these three values (plus an optional default `ASC_APP_ID`, discoverable later with the `list_apps` tool) to the server as environment variables:

| Variable | Value |
|---|---|
| `ASC_ISSUER_ID` | the Issuer ID UUID |
| `ASC_KEY_ID` | the key's ID, e.g. `ABC123DEFG` |
| `ASC_PRIVATE_KEY_PATH` **or** `ASC_PRIVATE_KEY_BASE64` | absolute path to the `.p8`, or `$(base64 -i AuthKey_XXXX.p8)` |

**Key handling:** the `.p8` is read lazily, never logged (Pino redaction covers key material), and never leaves the process — screenshots are downloaded from Apple's pre-signed CDN URLs *without* attaching your bearer token. `*.p8`, `data/`, and `screenshots/` are gitignored. JWTs are ES256, minted for 15 minutes (Apple's cap is 20), cached, refreshed proactively, and re-minted once on a 401.

The server boots **without** credentials too: local-state tools keep working and ASC-backed tools return instructions instead of failing cryptically.

### 2. Connect your MCP client

The npm package ships a `mcp-server-appstoreconnect` binary that speaks **stdio by default** (pass `--http` for the HTTP transport), so every client below is just "run it via npx with your credentials in the env block". Local state (SQLite cache, screenshots) lives in `~/.mcp-server-appstoreconnect/` regardless of which project the client spawns the server in.

#### Claude Code

```bash
claude mcp add appstoreconnect \
  --env ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --env ASC_KEY_ID=ABC123DEFG \
  --env ASC_PRIVATE_KEY_PATH=/absolute/path/AuthKey_ABC123DEFG.p8 \
  --env ASC_APP_ID=1234567890 \
  -- npx -y mcp-server-appstoreconnect
```

#### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "appstoreconnect": {
      "command": "npx",
      "args": ["-y", "mcp-server-appstoreconnect"],
      "env": {
        "ASC_ISSUER_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "ASC_KEY_ID": "ABC123DEFG",
        "ASC_PRIVATE_KEY_PATH": "/absolute/path/AuthKey_ABC123DEFG.p8",
        "ASC_APP_ID": "1234567890"
      }
    }
  }
}
```

#### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project) — identical shape to Claude Desktop:

```json
{
  "mcpServers": {
    "appstoreconnect": {
      "command": "npx",
      "args": ["-y", "mcp-server-appstoreconnect"],
      "env": {
        "ASC_ISSUER_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "ASC_KEY_ID": "ABC123DEFG",
        "ASC_PRIVATE_KEY_PATH": "/absolute/path/AuthKey_ABC123DEFG.p8",
        "ASC_APP_ID": "1234567890"
      }
    }
  }
}
```

#### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.appstoreconnect]
command = "npx"
args = ["-y", "mcp-server-appstoreconnect"]

[mcp_servers.appstoreconnect.env]
ASC_ISSUER_ID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
ASC_KEY_ID = "ABC123DEFG"
ASC_PRIVATE_KEY_PATH = "/absolute/path/AuthKey_ABC123DEFG.p8"
ASC_APP_ID = "1234567890"
```

#### Docker

Use `ASC_PRIVATE_KEY_BASE64` (no file mount needed) and a volume for persistent state:

```bash
docker run -i --rm \
  -e ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  -e ASC_KEY_ID=ABC123DEFG \
  -e ASC_PRIVATE_KEY_BASE64="$(base64 -i AuthKey_ABC123DEFG.p8)" \
  -e ASC_APP_ID=1234567890 \
  -v asc-mcp-state:/home/node/.mcp-server-appstoreconnect \
  ghcr.io/krishnal/mcp-server-appstoreconnect node dist/server.js --stdio
```

The same command works as an MCP client entry (`"command": "docker"`, args as above) — the `-i` flag is what keeps stdio open. Images are published to GHCR on version tags; or build locally with `npm run docker:build`.

### Running from source

Requires **Node.js ≥ 24** (`nvm use` picks up `.nvmrc`; `node:sqlite` ships with Node 24).

```bash
npm install
cp .env.example .env    # fill in the ASC_* credentials
npm run dev:stdio       # stdio transport — or `npm run dev` for HTTP
npm test                # 107 tests

# hook a source checkout into Claude Code:
npm run build
claude mcp add appstoreconnect -- node /absolute/path/to/mcp-server-appstoreconnect/dist/server.js --stdio
```

When run from a source checkout, the server auto-loads the `.env` in **its own project root** (never the spawn directory), and real environment variables always override it. In stdio mode all logs go to stderr; stdout is reserved for the protocol.

## Example Claude workflows

**Morning triage** (or just invoke the `triage_feedback` prompt):

> *"Check my TestFlight feedback. Group duplicates, prioritize what's pending, then walk me through the top 3 with screenshots."*

Claude calls `list_unprocessed` → `group_duplicates` → `prioritize_feedback`, then `analyze_feedback` per item — the screenshots come back as images Claude inspects directly, persisting its findings via `save_analysis`.

**From feedback to fix:**

> *"Analyze feedback fb-123, find the code responsible and fix it."*

`analyze_feedback` returns the screenshot + device context; Claude identifies the affected screen/component, greps your codebase, makes the change, then `generate_todo` tracks the verification steps and `mark_processed` closes the loop.

**From feedback to ticket:**

> *"File the checkout-overlap feedback as a GitHub issue and mark it processed with the issue number."*

`create_issue` bundles the comment, build/device context, analysis, TODO checklist, and screenshot paths — and it's idempotent, so retries return the existing issue instead of filing duplicates.

**Crash triage:**

> *"Any new crashes this week? Pull the crash logs and tell me what's crashing."*

`list_feedback (kind: crash, since: ...)` → `get_crash_log` → Claude reads the stack.

## Architecture

```
src/
├── asc/               # App Store Connect: ES256 token provider, typed API client
├── storage/           # node:sqlite FeedbackStore (cache, state, idempotency)
├── analysis/          # analyzer (Claude vision), similarity, prioritize, todo
├── issues/            # IssueProvider interface + github/jira/linear
├── services/          # composition of the above, injected as ctx.services
├── capabilities/      # MCP tools/resources/prompts (thin: parse → services → format)
├── core/              # boilerplate protocol engine (dispatcher, registry, sessions)
├── adapters/          # stdio.ts · http.ts · lambda.ts
└── config/            # Zod-validated env config
```

Layering: capabilities never speak HTTP or SQL; `asc/` never touches SQLite; `analysis/` and `issues/` depend only on domain types. Everything reaches handlers through one typed `ctx.services` bag built in the composition root — tests inject fakes there (see `tests/helpers/fixtures.ts`).

**Reliability & error handling:** App Store Connect 429s are retried honoring `Retry-After`; 401s trigger one token refresh+retry; expired screenshot URLs are re-fetched automatically; every upstream failure surfaces as an `isError` tool result with Apple's actual error detail so the calling LLM can self-correct. Handlers honor the request's `AbortSignal` (client cancellation and server timeouts).

**Idempotency:** `mark_processed`/`save_analysis`/`generate_todo` are upserts; `create_issue` files at most one issue per (feedback, provider) and returns the existing link on retries; re-listing feedback refreshes the cache without clobbering local state.

### The dual-mode AI analysis

Apple gives you the screenshot; someone needs vision to read it. Two ways, same stored result:

- **Host-delegated (default, zero config):** `analyze_feedback` returns the screenshot(s) as MCP image blocks + device context + instructions; the host model (Claude) analyzes and persists via `save_analysis`. Your API bill: nothing extra.
- **Autonomous (`ANTHROPIC_API_KEY` set):** the server calls Claude (`claude-opus-4-8` by default) with vision + structured outputs and stores the validated analysis itself. Useful for headless/batch use.

Downstream tools (`prioritize_feedback`, `generate_todo`, `create_issue`) read the same schema either way (`src/analysis/schema.ts`).

## Deployment

### Local (stdio) — recommended for Claude Code/Desktop

```bash
npm run build && npm run start:stdio
```

### Docker (HTTP)

```bash
docker build -f docker/Dockerfile -t mcp-server-appstoreconnect .
docker run --rm -p 3000:3000 \
  -e ASC_ISSUER_ID=... -e ASC_KEY_ID=... -e ASC_PRIVATE_KEY_BASE64="$(base64 -i AuthKey.p8)" \
  -e ASC_APP_ID=... -e HTTP_HOST=0.0.0.0 \
  -e AUTH_MODE=api-key -e API_KEYS=your-key:* \
  -v asc-mcp-state:/home/node/.mcp-server-appstoreconnect \
  mcp-server-appstoreconnect
```

Mount a volume at `/home/node/.mcp-server-appstoreconnect` (the default state location) so the cache, processed flags and screenshots survive restarts. Health checks: `/healthz` (liveness), `/readyz` (readiness); Prometheus metrics on `/metrics`.

### AWS Lambda

```bash
sam build && sam deploy --guided      # template.yaml (nodejs24.x, arm64)
# or: npm run build:lambda → dist/lambda/index.mjs, deploy with any tool
```

Use `ASC_PRIVATE_KEY_BASE64` (no filesystem needed) and set `STATE_DB_PATH=/tmp/testflight.db`, `SCREENSHOTS_DIR=/tmp/screenshots`. Because `node:sqlite` is built into the runtime, the single-file bundle just works — **but `/tmp` is per-container and ephemeral**, so processed flags and analyses reset between cold starts. For durable state on Lambda, mount EFS for the DB path; for the full feature set (sessions, subscriptions, persistent state) prefer the container deployment. Lambda runs stateless (ephemeral sessions, no server-push).

## Extending

**A new tool** (the boilerplate pattern still applies — schema + handler, register, done):

```ts
// src/capabilities/tools/my-tool.ts
export const myTool = defineTool({
  name: 'my_tool',
  description: '...',
  inputSchema: z.object({ feedbackId: z.string() }),
  handler: async ({ feedbackId }, ctx) => {
    const stored = ctx.services.store.getFeedback(feedbackId); // full services bag
    return { content: [{ type: 'text', text: '...' }] };
  },
});
// then registry.registerTool(myTool) in src/capabilities/index.ts
```

**A new issue provider:** implement the 1-method `IssueProvider` interface (`src/issues/types.ts`), add a config block in `src/config/index.ts`, register it in `createIssueProviders` (`src/issues/index.ts`). Idempotency comes for free from the `issues` table.

**Smarter duplicate detection:** swap the lexical scorer in `src/analysis/similarity.ts` for embeddings — `clusterFeedback`'s contract (items in, groups out) doesn't change.

**Polling / notifications:** the boilerplate supports subscribable resources — poll `listFeedback` on an interval from your business logic and call `appContext.notifyResourceUpdated(...)` to push `notifications/resources/updated` to subscribed clients (HTTP transport).

**Different storage:** `FeedbackStore` (`src/storage/feedback-store.ts`) is the entire storage surface — reimplement it over Postgres/DynamoDB/libsql and swap it in `createServices`.

## Testing

```bash
npm test              # 107 tests: unit + protocol-level + transport integration
npm run coverage
npm run typecheck
```

Capability tests drive the **real dispatcher** through `tests/helpers/mcp-test-client.ts` with fake ASC/issue services injected via the composition root (`tests/helpers/fixtures.ts`) — every tool is spec-tested without network. The ASC client and issue providers are tested against `undici` `MockAgent` upstreams (pagination, 401 refresh, 429 retry, error mapping). Token minting is tested with real ES256 keys and a fake clock.

## Configuration reference

See **`.env.example`** for the full annotated list. Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `ASC_ISSUER_ID` / `ASC_KEY_ID` | — | App Store Connect API key identity |
| `ASC_PRIVATE_KEY_PATH` \| `ASC_PRIVATE_KEY_BASE64` | — | the `.p8` key (exactly one) |
| `ASC_APP_ID` | — | default app for feedback tools |
| `STATE_DB_PATH` | `./data/testflight.db` | SQLite state (`:memory:` ok; `/tmp/...` on Lambda) |
| `SCREENSHOTS_DIR` | `./screenshots` | downloaded screenshot storage |
| `ANTHROPIC_API_KEY` | — | enables autonomous analysis (optional) |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | model for autonomous analysis |
| `GITHUB_TOKEN`+`GITHUB_REPO`, `JIRA_*`, `LINEAR_*` | — | issue providers (any subset) |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` (CLI `--stdio` overrides) |
| `AUTH_MODE` | `none` | `none` \| `api-key` \| `jwt` (HTTP edge) |

Partial provider/credential configuration fails at boot with a readable error — absence degrades gracefully, misconfiguration never does.

## License

[Apache License 2.0](LICENSE). Provided **as is**, without warranty of any kind — you are solely responsible for determining the appropriateness of using this software and assume all risks associated with it (see LICENSE §7 Disclaimer of Warranty and §8 Limitation of Liability), including any interaction it performs with your App Store Connect account, TestFlight data, or issue trackers.
