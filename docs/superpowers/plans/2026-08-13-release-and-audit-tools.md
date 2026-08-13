# Release & Review-Audit Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nine MCP tools covering App Store release (builds, readiness, version prep, review submission, release) and review-guideline auditing (proactive audit + rejection triage) to the App Store Connect MCP server.

**Architecture:** Extract the ASC client's transport (JWT auth, retries, pagination) into a shared `AscHttp` class gaining POST/PATCH support; add an `AscReleaseClient` beside the existing feedback client; add a `src/audit/` module with a curated guideline rule pack, an evaluation engine, a local Xcode-project scanner, and a rejection-text parser. Tools are thin handlers registered through the existing capability registry.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import suffixes), zod, undici, vitest + undici MockAgent, `plist` (new dependency) for Info.plist/entitlements/privacy-manifest parsing.

**Spec:** `docs/superpowers/specs/2026-08-13-release-and-audit-tools-design.md`

## Global Constraints

- Node >= 24; ESM only; relative imports use `.js` suffixes (`import x from '../asc/types.js'`).
- Existing tests MUST pass unchanged after every task: run `npm test` before each commit. `tests/unit/asc-client.test.ts` may not be edited in Task 1.
- Zod schemas for all tool inputs; `.describe()` on every field; tools defined with `defineTool` from `src/core/registry/define.js`.
- Error convention: handlers throw plain `Error` with actionable, user-relayable messages; the dispatcher converts them to `isError` results. ASC failures surface as `AscApiError` with Apple's `detail`.
- Tools must degrade without ASC credentials: `requireAsc`/`requireRelease` throw the `ASC_NOT_CONFIGURED` message. `triage_rejection` needs no credentials and must work without them.
- Only new dependency allowed: `plist` (+ `@types/plist` dev). Nothing else.
- Read tool annotations: `{ readOnlyHint: true, openWorldHint: true }`. Write tools: `{ readOnlyHint: false, openWorldHint: true }` plus `idempotentHint: true` on `prepare_app_store_version` and `distribute_build`.
- Verification commands: `npx vitest run <file>` for a single file, `npm test` for the suite, `npm run typecheck` for types.
- Commit after every task (steps include the exact commands). Conventional-commit style messages (`feat:`, `refactor:`, `test:`, `docs:`) matching the repo's history.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/asc/http.ts` (create) | Shared transport: auth header, 401-refresh-once, 429/5xx bounded retries, JSON bodies for POST/PATCH, 204 handling |
| `src/asc/client.ts` (modify) | Feedback client — unchanged public surface, `requestJson` delegates to `AscHttp` |
| `src/asc/types.ts` (modify) | Add wire + domain types for builds, versions, localizations, review submissions, beta groups, phased releases |
| `src/asc/release-client.ts` (create) | Release-domain client: all new read/write endpoints, JSON:API → domain mapping |
| `src/asc/readiness.ts` (create) | `gatherReadinessFacts` (parallel reads) + pure `buildReadinessReport` |
| `src/audit/types.ts` (create) | `AppFacts`, `ProjectFacts`, `GuidelineRule`, `Finding`, `SkippedCheck` |
| `src/audit/project-scan.ts` (create) | Walk a project dir; parse Info.plist / *.entitlements / PrivacyInfo.xcprivacy |
| `src/audit/engine.ts` (create) | `runAudit(rules, facts)` — applicability filter + rule evaluation |
| `src/audit/guidelines/{privacy,metadata,payments,completeness}.ts` + `index.ts` (create) | The v1 rule pack + `RULE_PACK_LAST_REVIEWED` |
| `src/audit/facts.ts` (create) | `gatherAppFacts` — ASC reads + optional project scan → `AppFacts` |
| `src/audit/rejection-parser.ts` (create) | Pasted rejection text → structured `RejectionItem[]` |
| `src/capabilities/tools/release.ts` (create) | 7 release tool definitions |
| `src/capabilities/tools/audit.ts` (create) | 2 audit tool definitions |
| `src/capabilities/tools/shared.ts` (modify) | Add `requireRelease` |
| `src/capabilities/index.ts` (modify) | Register the 9 new tools |
| `src/services/index.ts` (modify) | Build shared token provider once; expose `release` client |
| `tests/helpers/fixtures.ts` (modify) | `FakeRelease` + `fakeReleaseClient`; `createTestServices` accepts `release` |
| `tests/unit/asc-http.test.ts`, `release-client.test.ts`, `readiness.test.ts`, `release-tools.test.ts`, `project-scan.test.ts`, `audit-engine.test.ts`, `audit-tools.test.ts`, `rejection-parser.test.ts` (create) | Per-module tests |
| `tests/fixtures/sample-project/**` (create) | Fixture Xcode-project tree for the scanner |

---

### Task 1: Extract `AscHttp` transport with POST/PATCH support

**Files:**
- Create: `src/asc/http.ts`
- Modify: `src/asc/client.ts` (replace the private `requestJson` body with delegation; imports)
- Test: `tests/unit/asc-http.test.ts` (create) — and `tests/unit/asc-client.test.ts` must pass WITHOUT EDITS

**Interfaces:**
- Consumes: `AscTokenProvider` (`getToken(): Promise<string>`, `invalidate(): void`), `AscApiError`, `AscErrorBody` from `src/asc/types.js`, `Logger`.
- Produces: `class AscHttp { constructor(options: AscHttpOptions); request<T>(method: AscHttpMethod, pathOrUrl: string, options?: { body?: unknown; signal?: AbortSignal }): Promise<T> }` with `type AscHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'` and `interface AscHttpOptions { baseUrl: string; tokenProvider: AscTokenProvider; logger: Logger }`. Every later task builds on this.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/asc-http.test.ts`:

```ts
/**
 * AscHttp transport: write-method bodies, empty-response handling, and the
 * retry behavior shared with the read path.
 */
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AscHttp } from '../../src/asc/http.js';
import type { AscTokenProvider } from '../../src/asc/token-provider.js';
import { AscApiError } from '../../src/asc/types.js';
import { createSilentLogger } from '../../src/observability/logger.js';

const BASE = 'https://asc.test';

class FakeTokens {
  invalidations = 0;
  async getToken(): Promise<string> {
    return this.invalidations === 0 ? 'token-1' : 'token-2';
  }
  invalidate(): void {
    this.invalidations += 1;
  }
}

let agent: MockAgent;
let original: Dispatcher;
let tokens: FakeTokens;
let http: AscHttp;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  tokens = new FakeTokens();
  http = new AscHttp({
    baseUrl: BASE,
    tokenProvider: tokens as unknown as AscTokenProvider,
    logger: createSilentLogger(),
  });
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

describe('write methods', () => {
  it('POSTs a JSON body with content-type and returns the parsed response', async () => {
    let seenBody = '';
    let seenType = '';
    agent
      .get(BASE)
      .intercept({
        path: '/v1/things',
        method: 'POST',
        body: (b) => {
          seenBody = b;
          return true;
        },
      })
      .reply(201, { data: { type: 'things', id: 'thing-1' } });

    // undici exposes request headers via the intercept options function form:
    agent
      .get(BASE)
      .intercept({ path: '/v1/header-check', method: 'POST' })
      .reply((opts) => {
        seenType = (opts.headers as Record<string, string>)['content-type'] ?? '';
        return { statusCode: 201, data: { ok: true } };
      });

    const created = await http.request<{ data: { id: string } }>('POST', '/v1/things', {
      body: { data: { type: 'things', attributes: { name: 'x' } } },
    });
    expect(created.data.id).toBe('thing-1');
    expect(JSON.parse(seenBody)).toEqual({ data: { type: 'things', attributes: { name: 'x' } } });

    await http.request('POST', '/v1/header-check', { body: { a: 1 } });
    expect(seenType).toBe('application/json');
  });

  it('resolves undefined for 204 No Content (PATCH relationship writes)', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1/appStoreVersions/v1/relationships/build', method: 'PATCH' })
      .reply(204);

    const result = await http.request<void>('PATCH', '/v1/appStoreVersions/v1/relationships/build', {
      body: { data: { type: 'builds', id: 'b1' } },
    });
    expect(result).toBeUndefined();
  });

  it('refreshes the token and retries a write exactly once on 401', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1/things', method: 'POST' })
      .reply(401, { errors: [{ status: '401', detail: 'expired' }] });
    agent
      .get(BASE)
      .intercept({ path: '/v1/things', method: 'POST' })
      .reply(201, { data: { type: 'things', id: 'thing-2' } });

    const created = await http.request<{ data: { id: string } }>('POST', '/v1/things', {
      body: { data: {} },
    });
    expect(created.data.id).toBe('thing-2');
    expect(tokens.invalidations).toBe(1);
  });

  it('surfaces Apple conflict details from a 409 as AscApiError', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1/reviewSubmissions', method: 'POST' })
      .reply(409, {
        errors: [{ status: '409', code: 'ENTITY_ERROR', detail: 'A review submission already exists' }],
      });

    const error = await http
      .request('POST', '/v1/reviewSubmissions', { body: { data: {} } })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(AscApiError);
    expect(error).toMatchObject({ status: 409, message: 'A review submission already exists' });
  });

  it('appends the App Manager role hint to 403s on writes only', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1/things', method: 'POST' })
      .reply(403, { errors: [{ status: '403', detail: 'Forbidden' }] });

    const error = await http
      .request('POST', '/v1/things', { body: { data: {} } })
      .catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/App Manager role/);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run tests/unit/asc-http.test.ts`
Expected: FAIL — cannot resolve `src/asc/http.js`.

- [ ] **Step 3: Create `src/asc/http.ts`**

Move the retry logic out of `client.ts` verbatim, generalized to methods and bodies:

```ts
/**
 * Shared App Store Connect HTTP transport.
 *
 * Owns auth and reliability for every ASC call, read or write:
 *  - 401 → invalidate the cached JWT and retry once (key/token rotation)
 *  - 429 → honor Retry-After (bounded), bounded retries
 *  - 5xx → single retry with short backoff
 * Errors surface as typed {@link AscApiError} with Apple's `detail` message so
 * the calling LLM can self-correct. 204 / empty 2xx responses resolve to
 * `undefined` (relationship PATCHes and deletes have no body).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'undici';
import type { Logger } from '../observability/logger.js';
import type { AscTokenProvider } from './token-provider.js';
import { AscApiError, type AscErrorBody } from './types.js';

const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 10_000;

export type AscHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface AscHttpOptions {
  baseUrl: string;
  tokenProvider: AscTokenProvider;
  logger: Logger;
}

export class AscHttp {
  private readonly baseUrl: string;
  private readonly tokens: AscTokenProvider;
  private readonly logger: Logger;

  constructor(options: AscHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.tokens = options.tokenProvider;
    this.logger = options.logger;
  }

  async request<T>(
    method: AscHttpMethod,
    pathOrUrl: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;

    let attempt = 0;
    let retried401 = false;
    for (;;) {
      const token = await this.tokens.getToken();
      const response = await request(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        headersTimeout: 15_000,
        bodyTimeout: 30_000,
        signal: options.signal,
      });

      if (response.statusCode < 400) {
        if (response.statusCode === 204) {
          await response.body.dump();
          return undefined as T;
        }
        const text = await response.body.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const errorBody = (await response.body.json().catch(() => ({}))) as AscErrorBody;
      const detail = errorBody.errors
        ?.map((e) => e.detail ?? e.title)
        .filter(Boolean)
        .join('; ');

      // Expired/rotated token: mint a fresh one and retry exactly once.
      if (response.statusCode === 401 && !retried401) {
        retried401 = true;
        this.tokens.invalidate();
        this.logger.debug({ url, method }, 'ASC 401 — refreshing token and retrying');
        continue;
      }

      const retryable = response.statusCode === 429 || response.statusCode >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        attempt += 1;
        const retryAfterHeader = Number(response.headers['retry-after']);
        const delayMs = Number.isFinite(retryAfterHeader)
          ? Math.min(retryAfterHeader * 1000, MAX_RETRY_AFTER_MS)
          : 500 * attempt;
        this.logger.warn(
          { status: response.statusCode, attempt, delayMs, method },
          'ASC request rate-limited or failed upstream — retrying',
        );
        await sleep(delayMs, undefined, { signal: options.signal });
        continue;
      }

      const roleHint =
        response.statusCode === 403 && method !== 'GET'
          ? ' (write operations require an App Store Connect API key with the App Manager role)'
          : '';
      throw new AscApiError(
        (detail ?? `App Store Connect API returned HTTP ${response.statusCode}`) + roleHint,
        response.statusCode,
        errorBody.errors?.[0]?.code,
      );
    }
  }
}
```

- [ ] **Step 4: Rebase `src/asc/client.ts` onto `AscHttp`**

In `src/asc/client.ts`:
1. Add `import { AscHttp } from './http.js';`
2. Remove `import { setTimeout as sleep } from 'node:timers/promises';` and drop `AscErrorBody` from the types import (keep `request` from undici — `downloadScreenshot` still uses it).
3. Delete the constants `MAX_RETRIES` and `MAX_RETRY_AFTER_MS` (they moved to http.ts). Keep `MAX_PAGE_SIZE`.
4. Replace the private fields/constructor and `requestJson`:

```ts
export class AscClient {
  private readonly http: AscHttp;

  constructor(options: AscClientOptions) {
    this.http = new AscHttp(options);
  }
```

(`AscClientOptions` is structurally identical to `AscHttpOptions`; leave `AscClientOptions` exported as-is.)

```ts
  private async requestJson<T>(pathOrUrl: string, signal?: AbortSignal): Promise<T> {
    return this.http.request<T>('GET', pathOrUrl, { signal });
  }
```

5. Remove the now-unused `baseUrl`/`tokens`/`logger` private fields and any references (`downloadScreenshot` uses none of them).

- [ ] **Step 5: Run both test files**

Run: `npx vitest run tests/unit/asc-http.test.ts tests/unit/asc-client.test.ts`
Expected: PASS — all asc-http cases green AND every pre-existing asc-client case green with zero edits to that file.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/asc/http.ts src/asc/client.ts tests/unit/asc-http.test.ts
git commit -m "refactor: extract shared AscHttp transport with POST/PATCH support"
```

---

### Task 2: Release domain types + `AscReleaseClient` read surface

**Files:**
- Modify: `src/asc/types.ts` (append new sections; extend `BuildAttributes`)
- Create: `src/asc/release-client.ts`
- Test: `tests/unit/release-client.test.ts` (create)

**Interfaces:**
- Consumes: `AscHttp` from Task 1 (constructed internally from `AscHttpOptions`); wire types `AscListResponse`, `AscSingleResponse`, `AscResource`, `AscApiError`.
- Produces (used by Tasks 3–9, 12):

```ts
// types.ts additions
export type ReleaseType = 'AFTER_APPROVAL' | 'MANUAL' | 'SCHEDULED';
export interface BuildSummary { id: string; version?: string; uploadedDate?: string; processingState?: string; expired?: boolean; usesNonExemptEncryption?: boolean | null; }
export interface AppStoreVersionSummary { id: string; versionString?: string; state?: string; releaseType?: string; platform?: string; createdDate?: string; buildId?: string; buildVersion?: string; }
export interface VersionLocalizationSummary { id: string; locale?: string; description?: string; whatsNew?: string; supportUrl?: string; }
export interface ScreenshotSetSummary { id: string; displayType?: string; screenshotCount: number; }
export interface ReviewSubmissionSummary { id: string; state?: string; platform?: string; submittedDate?: string; }
export interface BetaGroupSummary { id: string; name?: string; isInternalGroup?: boolean; }
export interface BuildBetaDetailSummary { id: string; externalBuildState?: string; internalBuildState?: string; }
export interface PhasedReleaseSummary { id: string; phasedReleaseState?: string; currentDayNumber?: number; }
export interface ReviewDetailSummary { id: string; contactEmail?: string; contactFirstName?: string; contactLastName?: string; contactPhone?: string; demoAccountRequired?: boolean; }
export interface AppInfoSummary { appInfoId: string; privacyPolicyUrl?: string; ageRating: { declared: boolean; inAppControls?: string | null }; }
// release-client.ts — read methods (all take an optional trailing AbortSignal)
class AscReleaseClient {
  constructor(options: AscClientOptions)
  listBuilds(appId: string, options?: { limit?: number }, signal?): Promise<BuildSummary[]>
  getBuild(buildId: string, signal?): Promise<BuildSummary | undefined>
  listVersions(appId: string, options?: { platform?: string; limit?: number }, signal?): Promise<AppStoreVersionSummary[]>
  getVersionLocalizations(versionId: string, signal?): Promise<VersionLocalizationSummary[]>
  listScreenshotSets(localizationId: string, signal?): Promise<ScreenshotSetSummary[]>
  getReviewDetail(versionId: string, signal?): Promise<ReviewDetailSummary | undefined>
  getAppInfo(appId: string, signal?): Promise<AppInfoSummary | undefined>
  hasSubscriptions(appId: string, signal?): Promise<boolean>
  hasCustomEula(appId: string, signal?): Promise<boolean>
  listBetaGroups(appId: string, signal?): Promise<BetaGroupSummary[]>
  getBuildBetaDetail(buildId: string, signal?): Promise<BuildBetaDetailSummary | undefined>
  listReviewSubmissions(appId: string, options?: { limit?: number }, signal?): Promise<ReviewSubmissionSummary[]>
  getPhasedRelease(versionId: string, signal?): Promise<PhasedReleaseSummary | undefined>
}
```

- [ ] **Step 1: Append wire + domain types to `src/asc/types.ts`**

In the wire-types section, extend `BuildAttributes` and add:

```ts
export interface BuildAttributes {
  version?: string;
  uploadedDate?: string;
  expired?: boolean;
  processingState?: string;
  usesNonExemptEncryption?: boolean | null;
}

export interface AppStoreVersionAttributes {
  versionString?: string;
  platform?: string;
  /** Current ASC field; `appStoreState` is the deprecated pre-2023 name. */
  appVersionState?: string;
  appStoreState?: string;
  releaseType?: string;
  createdDate?: string;
}

export interface AppStoreVersionLocalizationAttributes {
  locale?: string;
  description?: string;
  whatsNew?: string;
  supportUrl?: string;
  keywords?: string;
  promotionalText?: string;
}

export interface AppScreenshotSetAttributes {
  screenshotDisplayType?: string;
}

export interface ReviewSubmissionAttributes {
  state?: string;
  platform?: string;
  submittedDate?: string;
}

export interface BetaGroupAttributes {
  name?: string;
  isInternalGroup?: boolean;
}

export interface BuildBetaDetailAttributes {
  externalBuildState?: string;
  internalBuildState?: string;
}

export interface PhasedReleaseAttributes {
  phasedReleaseState?: string;
  currentDayNumber?: number;
}

export interface ReviewDetailAttributes {
  contactEmail?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactPhone?: string;
  demoAccountRequired?: boolean;
}

export interface AppInfoLocalizationAttributes {
  locale?: string;
  privacyPolicyUrl?: string;
}

export interface AgeRatingDeclarationAttributes {
  /** e.g. 'NONE' | 'PARENTAL_CONTROLS' | 'AGE_ASSURANCE' (In-App Controls). */
  inAppControls?: string | null;
}
```

Then append the domain-types block exactly as listed in **Interfaces** above (with doc comments), in a new `// Release domain types` section.

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/release-client.test.ts` (same MockAgent scaffold as `asc-http.test.ts` — copy the imports, `FakeTokens`, `beforeEach`/`afterEach`, replacing `AscHttp` with `AscReleaseClient` from `../../src/asc/release-client.js`):

```ts
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AscReleaseClient } from '../../src/asc/release-client.js';
import type { AscTokenProvider } from '../../src/asc/token-provider.js';
import { createSilentLogger } from '../../src/observability/logger.js';

const BASE = 'https://asc.test';

class FakeTokens {
  async getToken(): Promise<string> {
    return 'token-1';
  }
  invalidate(): void {}
}

let agent: MockAgent;
let original: Dispatcher;
let client: AscReleaseClient;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  client = new AscReleaseClient({
    baseUrl: BASE,
    tokenProvider: new FakeTokens() as unknown as AscTokenProvider,
    logger: createSilentLogger(),
  });
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

function pool() {
  return agent.get(BASE);
}

describe('read surface', () => {
  it('listBuilds maps build resources newest-first', async () => {
    pool()
      .intercept({ path: /\/v1\/builds\?.*filter%5Bapp%5D=app-1.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'builds',
            id: 'build-2',
            attributes: {
              version: '422',
              uploadedDate: '2026-08-10T00:00:00Z',
              processingState: 'VALID',
              expired: false,
              usesNonExemptEncryption: null,
            },
          },
        ],
      });

    const builds = await client.listBuilds('app-1');
    expect(builds).toEqual([
      {
        id: 'build-2',
        version: '422',
        uploadedDate: '2026-08-10T00:00:00Z',
        processingState: 'VALID',
        expired: false,
        usesNonExemptEncryption: null,
      },
    ]);
  });

  it('listVersions reads appVersionState with appStoreState fallback and includes the build', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/appStoreVersions.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'appStoreVersions',
            id: 'v-1',
            attributes: {
              versionString: '2.4.0',
              platform: 'IOS',
              appVersionState: 'PREPARE_FOR_SUBMISSION',
              releaseType: 'AFTER_APPROVAL',
              createdDate: '2026-08-01T00:00:00Z',
            },
            relationships: { build: { data: { type: 'builds', id: 'build-2' } } },
          },
          {
            type: 'appStoreVersions',
            id: 'v-0',
            attributes: { versionString: '2.3.0', appStoreState: 'READY_FOR_SALE' },
          },
        ],
        included: [{ type: 'builds', id: 'build-2', attributes: { version: '422' } }],
      });

    const versions = await client.listVersions('app-1');
    expect(versions[0]).toMatchObject({
      id: 'v-1',
      versionString: '2.4.0',
      state: 'PREPARE_FOR_SUBMISSION',
      releaseType: 'AFTER_APPROVAL',
      buildId: 'build-2',
      buildVersion: '422',
    });
    expect(versions[1]).toMatchObject({ id: 'v-0', state: 'READY_FOR_SALE' });
  });

  it('listScreenshotSets counts included screenshots per set', async () => {
    pool()
      .intercept({ path: /\/v1\/appStoreVersionLocalizations\/loc-1\/appScreenshotSets.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'appScreenshotSets',
            id: 'set-1',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
            relationships: {
              appScreenshots: {
                data: [
                  { type: 'appScreenshots', id: 's1' },
                  { type: 'appScreenshots', id: 's2' },
                ],
              },
            },
          },
        ],
      });

    const sets = await client.listScreenshotSets('loc-1');
    expect(sets).toEqual([{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 2 }]);
  });

  it('getAppInfo combines localizations and the age rating declaration', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/appInfos.*/, method: 'GET' })
      .reply(200, { data: [{ type: 'appInfos', id: 'info-1', attributes: {} }] });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/appInfoLocalizations.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'appInfoLocalizations',
            id: 'il-1',
            attributes: { locale: 'en-US', privacyPolicyUrl: 'https://example.com/privacy' },
          },
        ],
      });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/ageRatingDeclaration.*/, method: 'GET' })
      .reply(200, {
        data: { type: 'ageRatingDeclarations', id: 'ar-1', attributes: { inAppControls: 'PARENTAL_CONTROLS' } },
      });

    const info = await client.getAppInfo('app-1');
    expect(info).toEqual({
      appInfoId: 'info-1',
      privacyPolicyUrl: 'https://example.com/privacy',
      ageRating: { declared: true, inAppControls: 'PARENTAL_CONTROLS' },
    });
  });

  it('getAppInfo marks the age rating undeclared on 404', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/appInfos.*/, method: 'GET' })
      .reply(200, { data: [{ type: 'appInfos', id: 'info-1', attributes: {} }] });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/appInfoLocalizations.*/, method: 'GET' })
      .reply(200, { data: [] });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/ageRatingDeclaration.*/, method: 'GET' })
      .reply(404, { errors: [{ status: '404' }] });

    const info = await client.getAppInfo('app-1');
    expect(info).toEqual({ appInfoId: 'info-1', privacyPolicyUrl: undefined, ageRating: { declared: false } });
  });

  it('hasSubscriptions / hasCustomEula map presence and 404', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/subscriptionGroups.*/, method: 'GET' })
      .reply(200, { data: [{ type: 'subscriptionGroups', id: 'sg-1' }] });
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/endUserLicenseAgreement.*/, method: 'GET' })
      .reply(404, { errors: [{ status: '404' }] });

    expect(await client.hasSubscriptions('app-1')).toBe(true);
    expect(await client.hasCustomEula('app-1')).toBe(false);
  });

  it('getPhasedRelease and getBuildBetaDetail return undefined on 404', async () => {
    pool()
      .intercept({ path: /\/v1\/appStoreVersions\/v-1\/appStoreVersionPhasedRelease.*/, method: 'GET' })
      .reply(404, { errors: [{ status: '404' }] });
    pool()
      .intercept({ path: /\/v1\/builds\/b-1\/buildBetaDetail.*/, method: 'GET' })
      .reply(200, {
        data: { type: 'buildBetaDetails', id: 'bd-1', attributes: { externalBuildState: 'READY_FOR_BETA_SUBMISSION' } },
      });

    expect(await client.getPhasedRelease('v-1')).toBeUndefined();
    expect(await client.getBuildBetaDetail('b-1')).toMatchObject({
      externalBuildState: 'READY_FOR_BETA_SUBMISSION',
    });
  });

  it('listReviewSubmissions filters by app', async () => {
    pool()
      .intercept({ path: /\/v1\/reviewSubmissions\?.*filter%5Bapp%5D=app-1.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'reviewSubmissions',
            id: 'rs-1',
            attributes: { state: 'WAITING_FOR_REVIEW', platform: 'IOS', submittedDate: '2026-08-11T00:00:00Z' },
          },
        ],
      });

    expect(await client.listReviewSubmissions('app-1')).toEqual([
      { id: 'rs-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS', submittedDate: '2026-08-11T00:00:00Z' },
    ]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/release-client.test.ts`
Expected: FAIL — cannot resolve `src/asc/release-client.js`.

- [ ] **Step 4: Create `src/asc/release-client.ts` (read surface)**

```ts
/**
 * App Store Connect API client — release surface.
 *
 * Everything the release-pipeline tools need that is not TestFlight feedback:
 * builds, App Store versions & localizations, review submissions, phased
 * releases, beta groups, app info (privacy policy, age rating) and
 * IAP/subscription presence. Shares transport semantics with the feedback
 * client via {@link AscHttp}. Write methods live here too (added task by
 * task); every method takes an optional trailing AbortSignal.
 */
import { AscHttp } from './http.js';
import type { AscClientOptions } from './client.js';
import {
  AscApiError,
  type AgeRatingDeclarationAttributes,
  type AppInfoLocalizationAttributes,
  type AppInfoSummary,
  type AppScreenshotSetAttributes,
  type AppStoreVersionAttributes,
  type AppStoreVersionLocalizationAttributes,
  type AppStoreVersionSummary,
  type AscListResponse,
  type AscResource,
  type AscSingleResponse,
  type BetaGroupAttributes,
  type BetaGroupSummary,
  type BuildAttributes,
  type BuildBetaDetailAttributes,
  type BuildBetaDetailSummary,
  type BuildSummary,
  type PhasedReleaseAttributes,
  type PhasedReleaseSummary,
  type ReviewDetailAttributes,
  type ReviewDetailSummary,
  type ReviewSubmissionAttributes,
  type ReviewSubmissionSummary,
  type ScreenshotSetSummary,
  type VersionLocalizationSummary,
} from './types.js';

const MAX_PAGE_SIZE = 200;

export class AscReleaseClient {
  private readonly http: AscHttp;

  constructor(options: AscClientOptions) {
    this.http = new AscHttp(options);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listBuilds(
    appId: string,
    options: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<BuildSummary[]> {
    const query = new URLSearchParams({
      'filter[app]': appId,
      sort: '-uploadedDate',
      'fields[builds]': 'version,uploadedDate,expired,processingState,usesNonExemptEncryption',
      limit: String(Math.min(options.limit ?? 20, MAX_PAGE_SIZE)),
    });
    const body = await this.http.request<AscListResponse<BuildAttributes>>(
      'GET',
      `/v1/builds?${query.toString()}`,
      { signal },
    );
    return body.data.map(toBuildSummary);
  }

  async getBuild(buildId: string, signal?: AbortSignal): Promise<BuildSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<BuildAttributes>>(
        'GET',
        `/v1/builds/${encodeURIComponent(buildId)}`,
        { signal },
      );
      return toBuildSummary(body.data);
    });
  }

  async listVersions(
    appId: string,
    options: { platform?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<AppStoreVersionSummary[]> {
    const query = new URLSearchParams({
      include: 'build',
      'fields[builds]': 'version',
      limit: String(Math.min(options.limit ?? 20, 50)),
    });
    if (options.platform) query.set('filter[platform]', options.platform);
    const body = await this.http.request<AscListResponse<AppStoreVersionAttributes>>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?${query.toString()}`,
      { signal },
    );
    const buildVersions = new Map<string, string>();
    for (const resource of body.included ?? []) {
      if (resource.type === 'builds') {
        const version = (resource.attributes as BuildAttributes | undefined)?.version;
        if (version) buildVersions.set(resource.id, version);
      }
    }
    return body.data.map((resource) => {
      const attributes = resource.attributes ?? {};
      const buildRef = resource.relationships?.['build']?.data;
      const buildId = buildRef && !Array.isArray(buildRef) ? buildRef.id : undefined;
      return {
        id: resource.id,
        versionString: attributes.versionString,
        state: attributes.appVersionState ?? attributes.appStoreState,
        releaseType: attributes.releaseType,
        platform: attributes.platform,
        createdDate: attributes.createdDate,
        buildId,
        buildVersion: buildId ? buildVersions.get(buildId) : undefined,
      };
    });
  }

  async getVersionLocalizations(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<VersionLocalizationSummary[]> {
    const body = await this.http.request<AscListResponse<AppStoreVersionLocalizationAttributes>>(
      'GET',
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=50`,
      { signal },
    );
    return body.data.map((resource) => ({
      id: resource.id,
      locale: resource.attributes?.locale,
      description: resource.attributes?.description,
      whatsNew: resource.attributes?.whatsNew,
      supportUrl: resource.attributes?.supportUrl,
    }));
  }

  async listScreenshotSets(
    localizationId: string,
    signal?: AbortSignal,
  ): Promise<ScreenshotSetSummary[]> {
    const body = await this.http.request<AscListResponse<AppScreenshotSetAttributes>>(
      'GET',
      `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets?include=appScreenshots&limit=50`,
      { signal },
    );
    return body.data.map((resource) => {
      const refs = resource.relationships?.['appScreenshots']?.data;
      return {
        id: resource.id,
        displayType: resource.attributes?.screenshotDisplayType,
        screenshotCount: Array.isArray(refs) ? refs.length : 0,
      };
    });
  }

  async getReviewDetail(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<ReviewDetailSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<ReviewDetailAttributes>>(
        'GET',
        `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreReviewDetail`,
        { signal },
      );
      return { id: body.data.id, ...body.data.attributes };
    });
  }

  async getAppInfo(appId: string, signal?: AbortSignal): Promise<AppInfoSummary | undefined> {
    const infos = await this.http.request<AscListResponse<Record<string, unknown>>>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/appInfos?limit=2`,
      { signal },
    );
    const appInfo = infos.data[0];
    if (!appInfo) return undefined;

    const [localizations, ageRating] = await Promise.all([
      this.http.request<AscListResponse<AppInfoLocalizationAttributes>>(
        'GET',
        `/v1/appInfos/${encodeURIComponent(appInfo.id)}/appInfoLocalizations?limit=50`,
        { signal },
      ),
      this.optional(() =>
        this.http.request<AscSingleResponse<AgeRatingDeclarationAttributes>>(
          'GET',
          `/v1/appInfos/${encodeURIComponent(appInfo.id)}/ageRatingDeclaration`,
          { signal },
        ),
      ),
    ]);

    const privacyPolicyUrl = localizations.data
      .map((loc) => loc.attributes?.privacyPolicyUrl)
      .find(Boolean);
    return {
      appInfoId: appInfo.id,
      privacyPolicyUrl,
      ageRating: ageRating
        ? { declared: true, inAppControls: ageRating.data.attributes?.inAppControls }
        : { declared: false },
    };
  }

  async hasSubscriptions(appId: string, signal?: AbortSignal): Promise<boolean> {
    const body = await this.http.request<AscListResponse>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=1`,
      { signal },
    );
    return body.data.length > 0;
  }

  async hasCustomEula(appId: string, signal?: AbortSignal): Promise<boolean> {
    const eula = await this.optional(() =>
      this.http.request<AscSingleResponse>(
        'GET',
        `/v1/apps/${encodeURIComponent(appId)}/endUserLicenseAgreement`,
        { signal },
      ),
    );
    return eula !== undefined;
  }

  async listBetaGroups(appId: string, signal?: AbortSignal): Promise<BetaGroupSummary[]> {
    const body = await this.http.request<AscListResponse<BetaGroupAttributes>>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/betaGroups?fields[betaGroups]=name,isInternalGroup&limit=${MAX_PAGE_SIZE}`,
      { signal },
    );
    return body.data.map((resource) => ({
      id: resource.id,
      name: resource.attributes?.name,
      isInternalGroup: resource.attributes?.isInternalGroup,
    }));
  }

  async getBuildBetaDetail(
    buildId: string,
    signal?: AbortSignal,
  ): Promise<BuildBetaDetailSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<BuildBetaDetailAttributes>>(
        'GET',
        `/v1/builds/${encodeURIComponent(buildId)}/buildBetaDetail`,
        { signal },
      );
      return { id: body.data.id, ...body.data.attributes };
    });
  }

  async listReviewSubmissions(
    appId: string,
    options: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ReviewSubmissionSummary[]> {
    const query = new URLSearchParams({
      'filter[app]': appId,
      limit: String(Math.min(options.limit ?? 10, 50)),
    });
    const body = await this.http.request<AscListResponse<ReviewSubmissionAttributes>>(
      'GET',
      `/v1/reviewSubmissions?${query.toString()}`,
      { signal },
    );
    return body.data.map((resource) => ({ id: resource.id, ...resource.attributes }));
  }

  async getPhasedRelease(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<PhasedReleaseSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<PhasedReleaseAttributes>>(
        'GET',
        `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionPhasedRelease`,
        { signal },
      );
      return { id: body.data.id, ...body.data.attributes };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Run a read, mapping 404 to undefined (resource legitimately absent). */
  private async optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AscApiError && err.status === 404) return undefined;
      throw err;
    }
  }
}

function toBuildSummary(resource: AscResource<BuildAttributes>): BuildSummary {
  const attributes = resource.attributes ?? {};
  return {
    id: resource.id,
    version: attributes.version,
    uploadedDate: attributes.uploadedDate,
    processingState: attributes.processingState,
    expired: attributes.expired,
    usesNonExemptEncryption: attributes.usesNonExemptEncryption,
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/unit/release-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + typecheck, then commit**

Run: `npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/asc/types.ts src/asc/release-client.ts tests/unit/release-client.test.ts
git commit -m "feat: release-domain types and AscReleaseClient read surface"
```

---

### Task 3: `AscReleaseClient` write surface

**Files:**
- Modify: `src/asc/release-client.ts` (append write methods before the Helpers section)
- Test: `tests/unit/release-client.test.ts` (append a `describe('write surface')` block)

**Interfaces:**
- Consumes: `AscHttp.request` with `'POST' | 'PATCH'`, `ReleaseType` from types.
- Produces (used by Tasks 7–9):

```ts
createVersion(appId: string, attrs: { versionString: string; platform: string; releaseType: ReleaseType }, signal?): Promise<AppStoreVersionSummary>
updateVersion(versionId: string, attrs: { releaseType?: ReleaseType }, signal?): Promise<void>
setVersionBuild(versionId: string, buildId: string, signal?): Promise<void>
updateLocalization(localizationId: string, attrs: { whatsNew?: string }, signal?): Promise<void>
createPhasedRelease(versionId: string, signal?): Promise<PhasedReleaseSummary>
createReviewSubmission(appId: string, platform: string, signal?): Promise<ReviewSubmissionSummary>
addReviewSubmissionItem(submissionId: string, versionId: string, signal?): Promise<void>
submitReviewSubmission(submissionId: string, signal?): Promise<ReviewSubmissionSummary>
createReleaseRequest(versionId: string, signal?): Promise<void>
setExportCompliance(buildId: string, usesNonExemptEncryption: boolean, signal?): Promise<void>
submitForBetaReview(buildId: string, signal?): Promise<void>
addBuildToBetaGroups(buildId: string, groupIds: string[], signal?): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/release-client.test.ts`:

```ts
describe('write surface', () => {
  function captureBody(path: string | RegExp, method: 'POST' | 'PATCH', statusCode: number, data: unknown) {
    const captured: { body?: unknown } = {};
    pool()
      .intercept({
        path,
        method,
        body: (b) => {
          captured.body = JSON.parse(b);
          return true;
        },
      })
      .reply(statusCode, data === undefined ? '' : { data });
    return captured;
  }

  it('createVersion posts the JSON:API document and returns a summary', async () => {
    const captured = captureBody('/v1/appStoreVersions', 'POST', 201, {
      type: 'appStoreVersions',
      id: 'v-9',
      attributes: { versionString: '2.4.0', appVersionState: 'PREPARE_FOR_SUBMISSION', releaseType: 'MANUAL' },
    });

    const version = await client.createVersion('app-1', {
      versionString: '2.4.0',
      platform: 'IOS',
      releaseType: 'MANUAL',
    });
    expect(version).toMatchObject({ id: 'v-9', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION' });
    expect(captured.body).toEqual({
      data: {
        type: 'appStoreVersions',
        attributes: { versionString: '2.4.0', platform: 'IOS', releaseType: 'MANUAL' },
        relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
      },
    });
  });

  it('setVersionBuild PATCHes the build relationship', async () => {
    const captured = captureBody('/v1/appStoreVersions/v-9/relationships/build', 'PATCH', 204, undefined);
    await client.setVersionBuild('v-9', 'build-2');
    expect(captured.body).toEqual({ data: { type: 'builds', id: 'build-2' } });
  });

  it('updateLocalization PATCHes whatsNew', async () => {
    const captured = captureBody('/v1/appStoreVersionLocalizations/loc-1', 'PATCH', 200, {
      type: 'appStoreVersionLocalizations',
      id: 'loc-1',
    });
    await client.updateLocalization('loc-1', { whatsNew: 'Bug fixes.' });
    expect(captured.body).toEqual({
      data: { type: 'appStoreVersionLocalizations', id: 'loc-1', attributes: { whatsNew: 'Bug fixes.' } },
    });
  });

  it('review submission lifecycle: create, add item, submit', async () => {
    const create = captureBody('/v1/reviewSubmissions', 'POST', 201, {
      type: 'reviewSubmissions',
      id: 'rs-9',
      attributes: { state: 'READY_FOR_REVIEW', platform: 'IOS' },
    });
    const item = captureBody('/v1/reviewSubmissionItems', 'POST', 201, {
      type: 'reviewSubmissionItems',
      id: 'item-1',
    });
    const submit = captureBody('/v1/reviewSubmissions/rs-9', 'PATCH', 200, {
      type: 'reviewSubmissions',
      id: 'rs-9',
      attributes: { state: 'WAITING_FOR_REVIEW' },
    });

    const submission = await client.createReviewSubmission('app-1', 'IOS');
    expect(submission).toMatchObject({ id: 'rs-9', state: 'READY_FOR_REVIEW' });
    expect(create.body).toEqual({
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
      },
    });

    await client.addReviewSubmissionItem('rs-9', 'v-9');
    expect(item.body).toEqual({
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: 'rs-9' } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-9' } },
        },
      },
    });

    const submitted = await client.submitReviewSubmission('rs-9');
    expect(submitted.state).toBe('WAITING_FOR_REVIEW');
    expect(submit.body).toEqual({
      data: { type: 'reviewSubmissions', id: 'rs-9', attributes: { submitted: true } },
    });
  });

  it('setExportCompliance PATCHes the build attribute', async () => {
    const captured = captureBody('/v1/builds/build-2', 'PATCH', 200, { type: 'builds', id: 'build-2' });
    await client.setExportCompliance('build-2', false);
    expect(captured.body).toEqual({
      data: { type: 'builds', id: 'build-2', attributes: { usesNonExemptEncryption: false } },
    });
  });

  it('submitForBetaReview and addBuildToBetaGroups post relationships', async () => {
    const beta = captureBody('/v1/betaAppReviewSubmissions', 'POST', 201, {
      type: 'betaAppReviewSubmissions',
      id: 'bars-1',
    });
    const groups = captureBody('/v1/builds/build-2/relationships/betaGroups', 'POST', 204, undefined);

    await client.submitForBetaReview('build-2');
    expect(beta.body).toEqual({
      data: {
        type: 'betaAppReviewSubmissions',
        relationships: { build: { data: { type: 'builds', id: 'build-2' } } },
      },
    });

    await client.addBuildToBetaGroups('build-2', ['g-1', 'g-2']);
    expect(groups.body).toEqual({
      data: [
        { type: 'betaGroups', id: 'g-1' },
        { type: 'betaGroups', id: 'g-2' },
      ],
    });
  });

  it('createReleaseRequest posts the version relationship', async () => {
    const captured = captureBody('/v1/appStoreVersionReleaseRequests', 'POST', 201, {
      type: 'appStoreVersionReleaseRequests',
      id: 'rr-1',
    });
    await client.createReleaseRequest('v-9');
    expect(captured.body).toEqual({
      data: {
        type: 'appStoreVersionReleaseRequests',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-9' } } },
      },
    });
  });

  it('createPhasedRelease posts the version relationship and returns state', async () => {
    const captured = captureBody('/v1/appStoreVersionPhasedReleases', 'POST', 201, {
      type: 'appStoreVersionPhasedReleases',
      id: 'pr-1',
      attributes: { phasedReleaseState: 'INACTIVE' },
    });
    const phased = await client.createPhasedRelease('v-9');
    expect(phased).toMatchObject({ id: 'pr-1', phasedReleaseState: 'INACTIVE' });
    expect(captured.body).toEqual({
      data: {
        type: 'appStoreVersionPhasedReleases',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-9' } } },
      },
    });
  });
});
```

- [ ] **Step 2: Run to verify the new block fails**

Run: `npx vitest run tests/unit/release-client.test.ts`
Expected: FAIL — write methods do not exist yet; the read `describe` stays green.

- [ ] **Step 3: Append the write methods to `src/asc/release-client.ts`**

Insert between the Reads section and the Helpers section (add `type ReleaseType` to the types import):

```ts
  // -------------------------------------------------------------------------
  // Writes — require an API key with the App Manager role
  // -------------------------------------------------------------------------

  async createVersion(
    appId: string,
    attrs: { versionString: string; platform: string; releaseType: ReleaseType },
    signal?: AbortSignal,
  ): Promise<AppStoreVersionSummary> {
    const body = await this.http.request<AscSingleResponse<AppStoreVersionAttributes>>(
      'POST',
      '/v1/appStoreVersions',
      {
        body: {
          data: {
            type: 'appStoreVersions',
            attributes: attrs,
            relationships: { app: { data: { type: 'apps', id: appId } } },
          },
        },
        signal,
      },
    );
    const a = body.data.attributes ?? {};
    return {
      id: body.data.id,
      versionString: a.versionString,
      state: a.appVersionState ?? a.appStoreState,
      releaseType: a.releaseType,
      platform: a.platform,
    };
  }

  async updateVersion(
    versionId: string,
    attrs: { releaseType?: ReleaseType },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('PATCH', `/v1/appStoreVersions/${encodeURIComponent(versionId)}`, {
      body: { data: { type: 'appStoreVersions', id: versionId, attributes: attrs } },
      signal,
    });
  }

  async setVersionBuild(versionId: string, buildId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request(
      'PATCH',
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`,
      { body: { data: { type: 'builds', id: buildId } }, signal },
    );
  }

  async updateLocalization(
    localizationId: string,
    attrs: { whatsNew?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request(
      'PATCH',
      `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`,
      {
        body: { data: { type: 'appStoreVersionLocalizations', id: localizationId, attributes: attrs } },
        signal,
      },
    );
  }

  async createPhasedRelease(versionId: string, signal?: AbortSignal): Promise<PhasedReleaseSummary> {
    const body = await this.http.request<AscSingleResponse<PhasedReleaseAttributes>>(
      'POST',
      '/v1/appStoreVersionPhasedReleases',
      {
        body: {
          data: {
            type: 'appStoreVersionPhasedReleases',
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        },
        signal,
      },
    );
    return { id: body.data.id, ...body.data.attributes };
  }

  async createReviewSubmission(
    appId: string,
    platform: string,
    signal?: AbortSignal,
  ): Promise<ReviewSubmissionSummary> {
    const body = await this.http.request<AscSingleResponse<ReviewSubmissionAttributes>>(
      'POST',
      '/v1/reviewSubmissions',
      {
        body: {
          data: {
            type: 'reviewSubmissions',
            attributes: { platform },
            relationships: { app: { data: { type: 'apps', id: appId } } },
          },
        },
        signal,
      },
    );
    return { id: body.data.id, ...body.data.attributes };
  }

  async addReviewSubmissionItem(
    submissionId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('POST', '/v1/reviewSubmissionItems', {
      body: {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
          },
        },
      },
      signal,
    });
  }

  async submitReviewSubmission(
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ReviewSubmissionSummary> {
    const body = await this.http.request<AscSingleResponse<ReviewSubmissionAttributes>>(
      'PATCH',
      `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`,
      {
        body: { data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } },
        signal,
      },
    );
    return { id: body.data.id, ...body.data.attributes };
  }

  async createReleaseRequest(versionId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request('POST', '/v1/appStoreVersionReleaseRequests', {
      body: {
        data: {
          type: 'appStoreVersionReleaseRequests',
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
        },
      },
      signal,
    });
  }

  async setExportCompliance(
    buildId: string,
    usesNonExemptEncryption: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('PATCH', `/v1/builds/${encodeURIComponent(buildId)}`, {
      body: { data: { type: 'builds', id: buildId, attributes: { usesNonExemptEncryption } } },
      signal,
    });
  }

  async submitForBetaReview(buildId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request('POST', '/v1/betaAppReviewSubmissions', {
      body: {
        data: {
          type: 'betaAppReviewSubmissions',
          relationships: { build: { data: { type: 'builds', id: buildId } } },
        },
      },
      signal,
    });
  }

  async addBuildToBetaGroups(
    buildId: string,
    groupIds: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('POST', `/v1/builds/${encodeURIComponent(buildId)}/relationships/betaGroups`, {
      body: { data: groupIds.map((id) => ({ type: 'betaGroups', id })) },
      signal,
    });
  }
```

- [ ] **Step 4: Run to verify pass, full suite, commit**

Run: `npx vitest run tests/unit/release-client.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/asc/release-client.ts tests/unit/release-client.test.ts
git commit -m "feat: AscReleaseClient write surface (versions, review submissions, beta distribution)"
```

---

### Task 4: Wire the release client into services, fixtures, and shared helpers

**Files:**
- Modify: `src/services/index.ts`
- Modify: `src/capabilities/tools/shared.ts`
- Modify: `tests/helpers/fixtures.ts`

**Interfaces:**
- Consumes: `AscReleaseClient` (Tasks 2–3), existing `LazyTokenProvider`.
- Produces:
  - `Services.release: AscReleaseClient | undefined` (undefined without ASC credentials).
  - `requireRelease(ctx: CapabilityContext): AscReleaseClient` in `shared.ts` (throws `ASC_NOT_CONFIGURED`).
  - Test fixtures: `interface FakeRelease` + `fakeReleaseClient(fake: FakeRelease): AscReleaseClient`; `TestServicesOptions.release?: AscReleaseClient`. Tool tests in Tasks 5–9 and 12 depend on the exact `FakeRelease` shape below.

- [ ] **Step 1: Modify `src/services/index.ts`**

Add `import { AscReleaseClient } from '../asc/release-client.js';`. In the `Services` interface, after `asc`, add:

```ts
  /** Release-pipeline client; undefined until ASC credentials are configured. */
  readonly release: AscReleaseClient | undefined;
```

In `createServices`, build the token provider once and share it:

```ts
  const tokenProvider = config.asc ? new LazyTokenProvider(config.asc) : undefined;
  const asc = tokenProvider
    ? new AscClient({ baseUrl: config.ascBaseUrl, tokenProvider, logger })
    : undefined;
  const release = tokenProvider
    ? new AscReleaseClient({ baseUrl: config.ascBaseUrl, tokenProvider, logger })
    : undefined;
```

and add `release,` to the returned object.

- [ ] **Step 2: Add `requireRelease` to `src/capabilities/tools/shared.ts`**

Add `import type { AscReleaseClient } from '../../asc/release-client.js';` and, directly below `requireAsc`:

```ts
export function requireRelease(ctx: CapabilityContext): AscReleaseClient {
  const release = ctx.services.release;
  if (!release) throw new Error(ASC_NOT_CONFIGURED);
  return release;
}
```

- [ ] **Step 3: Extend `tests/helpers/fixtures.ts`**

Add imports:

```ts
import type { AscReleaseClient } from '../../src/asc/release-client.js';
import type {
  AppStoreVersionSummary,
  BetaGroupSummary,
  BuildBetaDetailSummary,
  BuildSummary,
  PhasedReleaseSummary,
  ReviewDetailSummary,
  ReviewSubmissionSummary,
  ScreenshotSetSummary,
  VersionLocalizationSummary,
} from '../../src/asc/types.js';
```

Append the fake (canned data in, call log out — mirrors `fakeAscClient`):

```ts
export interface FakeRelease {
  builds: BuildSummary[];
  versions: AppStoreVersionSummary[];
  localizations: Map<string, VersionLocalizationSummary[]>;
  screenshotSets: Map<string, ScreenshotSetSummary[]>;
  reviewDetails: Map<string, ReviewDetailSummary>;
  appInfo?: { appInfoId: string; privacyPolicyUrl?: string; ageRating: { declared: boolean; inAppControls?: string | null } };
  subscriptions: boolean;
  customEula: boolean;
  betaGroups: BetaGroupSummary[];
  betaDetails: Map<string, BuildBetaDetailSummary>;
  reviewSubmissions: ReviewSubmissionSummary[];
  phasedReleases: Map<string, PhasedReleaseSummary>;
  calls: string[];
}

export function emptyFakeRelease(overrides: Partial<FakeRelease> = {}): FakeRelease {
  return {
    builds: [],
    versions: [],
    localizations: new Map(),
    screenshotSets: new Map(),
    reviewDetails: new Map(),
    appInfo: undefined,
    subscriptions: false,
    customEula: false,
    betaGroups: [],
    betaDetails: new Map(),
    reviewSubmissions: [],
    phasedReleases: new Map(),
    calls: [],
    ...overrides,
  };
}

/** Structural stand-in for AscReleaseClient. Writes mutate the canned data. */
export function fakeReleaseClient(fake: FakeRelease): AscReleaseClient {
  let idCounter = 0;
  const client = {
    async listBuilds() {
      fake.calls.push('listBuilds');
      return fake.builds;
    },
    async getBuild(buildId: string) {
      fake.calls.push(`getBuild:${buildId}`);
      return fake.builds.find((b) => b.id === buildId);
    },
    async listVersions() {
      fake.calls.push('listVersions');
      return fake.versions;
    },
    async getVersionLocalizations(versionId: string) {
      fake.calls.push(`getVersionLocalizations:${versionId}`);
      return fake.localizations.get(versionId) ?? [];
    },
    async listScreenshotSets(localizationId: string) {
      fake.calls.push(`listScreenshotSets:${localizationId}`);
      return fake.screenshotSets.get(localizationId) ?? [];
    },
    async getReviewDetail(versionId: string) {
      fake.calls.push(`getReviewDetail:${versionId}`);
      return fake.reviewDetails.get(versionId);
    },
    async getAppInfo() {
      fake.calls.push('getAppInfo');
      return fake.appInfo;
    },
    async hasSubscriptions() {
      fake.calls.push('hasSubscriptions');
      return fake.subscriptions;
    },
    async hasCustomEula() {
      fake.calls.push('hasCustomEula');
      return fake.customEula;
    },
    async listBetaGroups() {
      fake.calls.push('listBetaGroups');
      return fake.betaGroups;
    },
    async getBuildBetaDetail(buildId: string) {
      fake.calls.push(`getBuildBetaDetail:${buildId}`);
      return fake.betaDetails.get(buildId);
    },
    async listReviewSubmissions() {
      fake.calls.push('listReviewSubmissions');
      return fake.reviewSubmissions;
    },
    async getPhasedRelease(versionId: string) {
      fake.calls.push(`getPhasedRelease:${versionId}`);
      return fake.phasedReleases.get(versionId);
    },
    async createVersion(_appId: string, attrs: { versionString: string; platform: string; releaseType: string }) {
      fake.calls.push(`createVersion:${attrs.versionString}:${attrs.releaseType}`);
      const version = {
        id: `v-new-${(idCounter += 1)}`,
        versionString: attrs.versionString,
        state: 'PREPARE_FOR_SUBMISSION',
        releaseType: attrs.releaseType,
        platform: attrs.platform,
      };
      fake.versions.unshift(version);
      return version;
    },
    async updateVersion(versionId: string, attrs: { releaseType?: string }) {
      fake.calls.push(`updateVersion:${versionId}:${attrs.releaseType ?? ''}`);
      const version = fake.versions.find((v) => v.id === versionId);
      if (version && attrs.releaseType) version.releaseType = attrs.releaseType;
    },
    async setVersionBuild(versionId: string, buildId: string) {
      fake.calls.push(`setVersionBuild:${versionId}:${buildId}`);
      const version = fake.versions.find((v) => v.id === versionId);
      if (version) version.buildId = buildId;
    },
    async updateLocalization(localizationId: string, attrs: { whatsNew?: string }) {
      fake.calls.push(`updateLocalization:${localizationId}:${attrs.whatsNew ?? ''}`);
    },
    async createPhasedRelease(versionId: string) {
      fake.calls.push(`createPhasedRelease:${versionId}`);
      const phased = { id: `pr-${(idCounter += 1)}`, phasedReleaseState: 'INACTIVE' };
      fake.phasedReleases.set(versionId, phased);
      return phased;
    },
    async createReviewSubmission(_appId: string, platform: string) {
      fake.calls.push(`createReviewSubmission:${platform}`);
      const submission = { id: `rs-${(idCounter += 1)}`, state: 'READY_FOR_REVIEW', platform };
      fake.reviewSubmissions.unshift(submission);
      return submission;
    },
    async addReviewSubmissionItem(submissionId: string, versionId: string) {
      fake.calls.push(`addReviewSubmissionItem:${submissionId}:${versionId}`);
    },
    async submitReviewSubmission(submissionId: string) {
      fake.calls.push(`submitReviewSubmission:${submissionId}`);
      const submission = fake.reviewSubmissions.find((s) => s.id === submissionId);
      if (submission) submission.state = 'WAITING_FOR_REVIEW';
      return submission ?? { id: submissionId, state: 'WAITING_FOR_REVIEW' };
    },
    async createReleaseRequest(versionId: string) {
      fake.calls.push(`createReleaseRequest:${versionId}`);
    },
    async setExportCompliance(buildId: string, uses: boolean) {
      fake.calls.push(`setExportCompliance:${buildId}:${String(uses)}`);
      const build = fake.builds.find((b) => b.id === buildId);
      if (build) build.usesNonExemptEncryption = uses;
    },
    async submitForBetaReview(buildId: string) {
      fake.calls.push(`submitForBetaReview:${buildId}`);
    },
    async addBuildToBetaGroups(buildId: string, groupIds: string[]) {
      fake.calls.push(`addBuildToBetaGroups:${buildId}:${groupIds.join(',')}`);
    },
  };
  return client as unknown as AscReleaseClient;
}
```

Extend `TestServicesOptions` and `createTestServices`:

```ts
export interface TestServicesOptions {
  asc?: AscClient | undefined;
  release?: AscReleaseClient | undefined;
  providers?: IssueProvider[];
}
```

and in the returned services object add `release: options.release,`.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: PASS (nothing consumes `release` yet; this task is wiring only — its behavior is exercised by every tool test from Task 5 on).

```bash
git add src/services/index.ts src/capabilities/tools/shared.ts tests/helpers/fixtures.ts
git commit -m "feat: wire AscReleaseClient into services, shared helpers, and test fixtures"
```

---

### Task 5: Read tools — `list_builds` and `get_release_status`

**Files:**
- Create: `src/capabilities/tools/release.ts`
- Modify: `src/capabilities/index.ts`
- Test: `tests/unit/release-tools.test.ts` (create)

**Interfaces:**
- Consumes: `requireRelease`, `resolveAppId`, `jsonResult` from `shared.js`; `AscReleaseClient` reads; fixtures from Task 4.
- Produces: `listBuildsTool`, `getReleaseStatusTool` (`ToolDefinition`s). The test scaffold built here (`setupRelease`) is reused by Tasks 6–9 and 12.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/release-tools.test.ts`:

```ts
/**
 * Protocol-level tests of the release tools, driven through the real
 * dispatcher with a fake release client injected via the composition root.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/core/container.js';
import type { CallToolResult } from '../../src/core/protocol/types.js';
import { createTestApp, McpTestClient } from '../helpers/mcp-test-client.js';
import { createTestServices, emptyFakeRelease, fakeReleaseClient, type FakeRelease } from '../helpers/fixtures.js';

const apps: AppContext[] = [];
afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

export interface ReleaseSetup {
  client: McpTestClient;
  fake: FakeRelease;
}

export async function setupRelease(fake: FakeRelease): Promise<ReleaseSetup> {
  const services = createTestServices({ release: fakeReleaseClient(fake) });
  const context = createTestApp({ ASC_APP_ID: 'app-1' }, { services });
  apps.push(context);
  const client = new McpTestClient(context);
  await client.initialize();
  return { client, fake };
}

export function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('no text content');
  return block.text;
}

export function json(result: CallToolResult): any {
  return JSON.parse(firstText(result));
}

export async function call(
  client: McpTestClient,
  name: string,
  args: unknown = {},
): Promise<CallToolResult> {
  return client.request<CallToolResult>('tools/call', { name, arguments: args });
}

describe('list_builds', () => {
  it('returns build summaries', async () => {
    const { client } = await setupRelease(
      emptyFakeRelease({
        builds: [
          { id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: null },
        ],
      }),
    );
    const result = json(await call(client, 'list_builds'));
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0]).toMatchObject({ id: 'build-2', version: '422', processingState: 'VALID' });
  });

  it('explains missing ASC configuration', async () => {
    const services = createTestServices({});
    const context = createTestApp({ ASC_APP_ID: 'app-1' }, { services });
    apps.push(context);
    const client = new McpTestClient(context);
    await client.initialize();
    const result = await call(client, 'list_builds');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/ASC_ISSUER_ID/);
  });
});

describe('get_release_status', () => {
  it('reports versions, review submissions, and phased release progress', async () => {
    const { client } = await setupRelease(
      emptyFakeRelease({
        versions: [
          { id: 'v-1', versionString: '2.4.0', state: 'PENDING_DEVELOPER_RELEASE', releaseType: 'MANUAL' },
          { id: 'v-0', versionString: '2.3.0', state: 'READY_FOR_SALE' },
        ],
        reviewSubmissions: [{ id: 'rs-1', state: 'COMPLETE', platform: 'IOS' }],
        phasedReleases: new Map([['v-1', { id: 'pr-1', phasedReleaseState: 'ACTIVE', currentDayNumber: 3 }]]),
      }),
    );
    const result = json(await call(client, 'get_release_status'));
    expect(result.versions[0]).toMatchObject({ versionString: '2.4.0', state: 'PENDING_DEVELOPER_RELEASE' });
    expect(result.reviewSubmissions[0]).toMatchObject({ state: 'COMPLETE' });
    expect(result.versions[0].phasedRelease).toMatchObject({ phasedReleaseState: 'ACTIVE', currentDayNumber: 3 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/release-tools.test.ts`
Expected: FAIL — unknown tools (`-32602` style protocol errors) because nothing is registered.

- [ ] **Step 3: Create `src/capabilities/tools/release.ts` with the two read tools**

```ts
/**
 * Release-pipeline tools: builds, readiness, version preparation, review
 * submission, and release. Write tools report per-step outcomes so a re-run
 * resumes instead of duplicating work (each step checks current state first).
 * All write operations need an ASC API key with the App Manager role.
 */
import { z } from 'zod';
import { defineTool } from '../../core/registry/define.js';
import type { AppStoreVersionSummary } from '../../asc/types.js';
import { jsonResult, requireRelease, resolveAppId } from './shared.js';

export interface StepOutcome {
  step: string;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
}

export const listBuildsTool = defineTool({
  name: 'list_builds',
  title: 'List builds',
  description:
    'Lists uploaded builds for an app (newest first): id, version, processing state, expiry, and ' +
    'export-compliance status. Use the build id with distribute_build or prepare_app_store_version.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    limit: z.number().int().min(1).max(200).optional().describe('Max builds to return (default 20)'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ appId, limit }, ctx) => {
    const release = requireRelease(ctx);
    const builds = await release.listBuilds(resolveAppId(appId, ctx), { limit }, ctx.signal);
    if (builds.length === 0) {
      return jsonResult({
        builds: [],
        note: 'No builds found. Upload a build with Xcode, Transporter, or CI first.',
      });
    }
    return jsonResult({ builds });
  },
});

export const getReleaseStatusTool = defineTool({
  name: 'get_release_status',
  title: 'Get release status',
  description:
    'Post-submission tracking: recent App Store versions with their states, review submissions, ' +
    'and phased-release progress. Use after submit_for_review to watch review and rollout.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    platform: z.string().optional().describe('Filter versions by platform, e.g. "IOS"'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ appId, platform }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const [versions, reviewSubmissions] = await Promise.all([
      release.listVersions(resolved, { platform, limit: 5 }, ctx.signal),
      release.listReviewSubmissions(resolved, { limit: 5 }, ctx.signal),
    ]);
    const withPhased = await Promise.all(
      versions.map(async (version: AppStoreVersionSummary) => ({
        ...version,
        phasedRelease: await release.getPhasedRelease(version.id, ctx.signal),
      })),
    );
    return jsonResult({ versions: withPhased, reviewSubmissions });
  },
});
```

- [ ] **Step 4: Register in `src/capabilities/index.ts`**

Add the import and registrations (a new `// Release pipeline` group after `// Integrations`):

```ts
import { getReleaseStatusTool, listBuildsTool } from './tools/release.js';
```

```ts
    // Release pipeline
    .registerTool(listBuildsTool)
    .registerTool(getReleaseStatusTool)
```

- [ ] **Step 5: Run to verify pass, full suite, commit**

Run: `npx vitest run tests/unit/release-tools.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/capabilities/tools/release.ts src/capabilities/index.ts tests/unit/release-tools.test.ts
git commit -m "feat: list_builds and get_release_status tools"
```

---

### Task 6: Readiness module + `check_submission_readiness` tool

**Files:**
- Create: `src/asc/readiness.ts`
- Modify: `src/capabilities/tools/release.ts` (add tool), `src/capabilities/index.ts` (register)
- Test: `tests/unit/readiness.test.ts` (create), `tests/unit/release-tools.test.ts` (append)

**Interfaces:**
- Consumes: `AscReleaseClient` reads (Task 2), summary types.
- Produces (Task 9's preflight depends on all of these):

```ts
export const EDITABLE_STATES: readonly string[];  // states a version can be edited/submitted from
export interface ReadinessCheck { name: string; status: 'pass' | 'fail' | 'warn'; detail: string; }
export interface ReadinessReport { ready: boolean; versionId?: string; versionString?: string; state?: string; checks: ReadinessCheck[]; }
export interface ReadinessFacts {
  version?: AppStoreVersionSummary;
  build?: BuildSummary;
  localizations: VersionLocalizationSummary[];
  screenshotSets: Map<string, ScreenshotSetSummary[]>;  // localization id → sets
  reviewDetail?: ReviewDetailSummary;
  appInfo?: AppInfoSummary;
}
export function buildReadinessReport(facts: ReadinessFacts): ReadinessReport;  // pure
export async function gatherReadinessFacts(release: AscReleaseClient, appId: string, platform: string | undefined, signal?: AbortSignal): Promise<ReadinessFacts>;
```

- [ ] **Step 1: Write the failing pure-function tests**

Create `tests/unit/readiness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildReadinessReport, type ReadinessFacts } from '../../src/asc/readiness.js';

function readyFacts(): ReadinessFacts {
  return {
    version: {
      id: 'v-1',
      versionString: '2.4.0',
      state: 'PREPARE_FOR_SUBMISSION',
      buildId: 'build-2',
    },
    build: { id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false },
    localizations: [{ id: 'loc-1', locale: 'en-US', description: 'A great app.', whatsNew: 'Fixes.' }],
    screenshotSets: new Map([['loc-1', [{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 3 }]]]),
    reviewDetail: { id: 'rd-1', contactEmail: 'dev@example.com', contactFirstName: 'Dev' },
    appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/privacy', ageRating: { declared: true } },
  };
}

function checkByName(report: ReturnType<typeof buildReadinessReport>, name: string) {
  const check = report.checks.find((c) => c.name === name);
  if (!check) throw new Error(`missing check ${name}`);
  return check;
}

describe('buildReadinessReport', () => {
  it('is ready when every check passes', () => {
    const report = buildReadinessReport(readyFacts());
    expect(report.ready).toBe(true);
    expect(report.versionId).toBe('v-1');
    expect(report.checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('fails without an editable version and mentions prepare_app_store_version', () => {
    const report = buildReadinessReport({ ...readyFacts(), version: undefined, build: undefined });
    expect(report.ready).toBe(false);
    expect(checkByName(report, 'version-exists')).toMatchObject({ status: 'fail' });
    expect(checkByName(report, 'version-exists').detail).toMatch(/prepare_app_store_version/);
  });

  it('fails when no build is attached', () => {
    const facts = readyFacts();
    facts.version = { ...facts.version!, buildId: undefined };
    facts.build = undefined;
    const report = buildReadinessReport(facts);
    expect(checkByName(report, 'build-attached').status).toBe('fail');
  });

  it('fails on unprocessed or expired builds', () => {
    const facts = readyFacts();
    facts.build = { ...facts.build!, processingState: 'PROCESSING' };
    expect(checkByName(buildReadinessReport(facts), 'build-processed').status).toBe('fail');
    facts.build = { ...facts.build!, processingState: 'VALID', expired: true };
    expect(checkByName(buildReadinessReport(facts), 'build-processed').status).toBe('fail');
  });

  it('fails when export compliance is unanswered', () => {
    const facts = readyFacts();
    facts.build = { ...facts.build!, usesNonExemptEncryption: null };
    const check = checkByName(buildReadinessReport(facts), 'export-compliance');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/distribute_build/);
  });

  it('fails on missing description, privacy policy, review contact, age rating; warns on missing whatsNew and screenshots', () => {
    const facts = readyFacts();
    facts.localizations = [{ id: 'loc-1', locale: 'en-US' }];
    facts.screenshotSets = new Map([['loc-1', []]]);
    facts.reviewDetail = undefined;
    facts.appInfo = { appInfoId: 'info-1', ageRating: { declared: false } };
    const report = buildReadinessReport(facts);
    expect(checkByName(report, 'description').status).toBe('fail');
    expect(checkByName(report, 'whats-new').status).toBe('warn');
    expect(checkByName(report, 'screenshots').status).toBe('fail');
    expect(checkByName(report, 'privacy-policy').status).toBe('fail');
    expect(checkByName(report, 'review-contact').status).toBe('fail');
    expect(checkByName(report, 'age-rating').status).toBe('fail');
    expect(report.ready).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/readiness.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/asc/readiness.ts`**

```ts
/**
 * Submission-readiness: the deterministic completeness gate.
 *
 * `gatherReadinessFacts` performs the (parallel) ASC reads; the pure
 * `buildReadinessReport` turns facts into a structured checklist the calling
 * LLM can act on. This gate is about *completeness* (is everything present),
 * not guideline compliance — that is src/audit/'s job.
 */
import type { AscReleaseClient } from './release-client.js';
import type {
  AppInfoSummary,
  AppStoreVersionSummary,
  BuildSummary,
  ReviewDetailSummary,
  ScreenshotSetSummary,
  VersionLocalizationSummary,
} from './types.js';

/** Version states from which metadata can be edited and a submission started. */
export const EDITABLE_STATES: readonly string[] = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
];

export interface ReadinessCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  versionId?: string;
  versionString?: string;
  state?: string;
  checks: ReadinessCheck[];
}

export interface ReadinessFacts {
  version?: AppStoreVersionSummary;
  build?: BuildSummary;
  localizations: VersionLocalizationSummary[];
  screenshotSets: Map<string, ScreenshotSetSummary[]>;
  reviewDetail?: ReviewDetailSummary;
  appInfo?: AppInfoSummary;
}

export async function gatherReadinessFacts(
  release: AscReleaseClient,
  appId: string,
  platform: string | undefined,
  signal?: AbortSignal,
): Promise<ReadinessFacts> {
  const versions = await release.listVersions(appId, { platform, limit: 10 }, signal);
  const version = versions.find((v) => v.state && EDITABLE_STATES.includes(v.state));
  if (!version) {
    return { version: undefined, localizations: [], screenshotSets: new Map() };
  }

  const [build, localizations, reviewDetail, appInfo] = await Promise.all([
    version.buildId ? release.getBuild(version.buildId, signal) : Promise.resolve(undefined),
    release.getVersionLocalizations(version.id, signal),
    release.getReviewDetail(version.id, signal),
    release.getAppInfo(appId, signal),
  ]);

  const screenshotSets = new Map<string, ScreenshotSetSummary[]>();
  await Promise.all(
    localizations.map(async (loc) => {
      screenshotSets.set(loc.id, await release.listScreenshotSets(loc.id, signal));
    }),
  );

  return { version, build, localizations, screenshotSets, reviewDetail, appInfo };
}

export function buildReadinessReport(facts: ReadinessFacts): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const { version, build } = facts;

  if (!version) {
    checks.push({
      name: 'version-exists',
      status: 'fail',
      detail:
        'No App Store version in an editable state. Create one with prepare_app_store_version.',
    });
    return { ready: false, checks };
  }
  checks.push({
    name: 'version-exists',
    status: 'pass',
    detail: `Version ${version.versionString ?? '?'} is ${version.state ?? 'unknown'}.`,
  });

  if (!version.buildId) {
    checks.push({
      name: 'build-attached',
      status: 'fail',
      detail: 'No build attached. Pick one with list_builds and attach it via prepare_app_store_version.',
    });
  } else {
    checks.push({ name: 'build-attached', status: 'pass', detail: `Build ${version.buildVersion ?? version.buildId} attached.` });
    if (!build || build.processingState !== 'VALID' || build.expired) {
      checks.push({
        name: 'build-processed',
        status: 'fail',
        detail: build
          ? `Build is ${build.expired ? 'expired' : (build.processingState ?? 'unknown')} — attach a valid build.`
          : 'Attached build no longer exists — attach a valid build.',
      });
    } else {
      checks.push({ name: 'build-processed', status: 'pass', detail: 'Build processed and valid.' });
    }
    if (build && (build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined)) {
      checks.push({
        name: 'export-compliance',
        status: 'fail',
        detail:
          'Export-compliance not declared for the build. Set it via distribute_build ' +
          '(usesNonExemptEncryption) or answer in App Store Connect.',
      });
    } else if (build) {
      checks.push({ name: 'export-compliance', status: 'pass', detail: 'Encryption declaration present.' });
    }
  }

  const hasDescription = facts.localizations.some((loc) => Boolean(loc.description?.trim()));
  checks.push(
    hasDescription
      ? { name: 'description', status: 'pass', detail: 'App description present.' }
      : { name: 'description', status: 'fail', detail: 'No localization has a description — add one in App Store Connect.' },
  );

  const hasWhatsNew = facts.localizations.some((loc) => Boolean(loc.whatsNew?.trim()));
  checks.push(
    hasWhatsNew
      ? { name: 'whats-new', status: 'pass', detail: "What's-new text present." }
      : {
          name: 'whats-new',
          status: 'warn',
          detail: "No what's-new text (required for updates; not for a first release). Set it via prepare_app_store_version.",
        },
  );

  const localesMissingShots = facts.localizations
    .filter((loc) => {
      const sets = facts.screenshotSets.get(loc.id) ?? [];
      return !sets.some((set) => set.screenshotCount > 0);
    })
    .map((loc) => loc.locale ?? loc.id);
  checks.push(
    localesMissingShots.length === 0
      ? { name: 'screenshots', status: 'pass', detail: 'Every localization has screenshots.' }
      : {
          name: 'screenshots',
          status: 'fail',
          detail: `No screenshots for: ${localesMissingShots.join(', ')}. Upload them in App Store Connect.`,
        },
  );

  checks.push(
    facts.appInfo?.privacyPolicyUrl
      ? { name: 'privacy-policy', status: 'pass', detail: 'Privacy policy URL set.' }
      : { name: 'privacy-policy', status: 'fail', detail: 'No privacy policy URL — set it on the App Information page.' },
  );

  checks.push(
    facts.reviewDetail?.contactEmail
      ? { name: 'review-contact', status: 'pass', detail: 'Review contact present.' }
      : { name: 'review-contact', status: 'fail', detail: 'App Review contact info missing — fill it in App Store Connect.' },
  );

  checks.push(
    facts.appInfo?.ageRating.declared
      ? { name: 'age-rating', status: 'pass', detail: 'Age rating declared.' }
      : { name: 'age-rating', status: 'fail', detail: 'Age rating not declared — complete it on the App Information page.' },
  );

  return {
    ready: !checks.some((c) => c.status === 'fail'),
    versionId: version.id,
    versionString: version.versionString,
    state: version.state,
    checks,
  };
}
```

- [ ] **Step 4: Run to verify the pure tests pass**

Run: `npx vitest run tests/unit/readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the tool and register it**

In `src/capabilities/tools/release.ts` add:

```ts
import { buildReadinessReport, gatherReadinessFacts } from '../../asc/readiness.js';
```

```ts
export const checkSubmissionReadinessTool = defineTool({
  name: 'check_submission_readiness',
  title: 'Check submission readiness',
  description:
    'Deterministic completeness gate for App Store submission: verifies an editable version exists ' +
    'with a processed build, export compliance, description, screenshots, privacy policy, review ' +
    'contact, and age rating. Returns {ready, checks[]}. submit_for_review runs this automatically.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    platform: z.string().optional().describe('Platform, e.g. "IOS" (default: all)'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ appId, platform }, ctx) => {
    const release = requireRelease(ctx);
    const facts = await gatherReadinessFacts(release, resolveAppId(appId, ctx), platform, ctx.signal);
    return jsonResult(buildReadinessReport(facts));
  },
});
```

Register in `src/capabilities/index.ts` (add `checkSubmissionReadinessTool` to the release import and `.registerTool(checkSubmissionReadinessTool)` in the Release pipeline group).

- [ ] **Step 6: Append a protocol-level test**

Append to `tests/unit/release-tools.test.ts`:

```ts
describe('check_submission_readiness', () => {
  it('reports failing checks for an empty app', async () => {
    const { client } = await setupRelease(emptyFakeRelease());
    const result = json(await call(client, 'check_submission_readiness'));
    expect(result.ready).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: 'version-exists', status: 'fail' });
  });

  it('passes for a fully prepared version', async () => {
    const { client } = await setupRelease(
      emptyFakeRelease({
        versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION', buildId: 'build-2', buildVersion: '422' }],
        builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
        localizations: new Map([
          ['v-1', [{ id: 'loc-1', locale: 'en-US', description: 'A great app.', whatsNew: 'Fixes.' }]],
        ]),
        screenshotSets: new Map([['loc-1', [{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 3 }]]]),
        reviewDetails: new Map([['v-1', { id: 'rd-1', contactEmail: 'dev@example.com' }]]),
        appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/p', ageRating: { declared: true } },
      }),
    );
    const result = json(await call(client, 'check_submission_readiness'));
    expect(result.ready).toBe(true);
    expect(result.versionId).toBe('v-1');
  });
});
```

- [ ] **Step 7: Run, full suite, commit**

Run: `npx vitest run tests/unit/readiness.test.ts tests/unit/release-tools.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/asc/readiness.ts src/capabilities/tools/release.ts src/capabilities/index.ts tests/unit/readiness.test.ts tests/unit/release-tools.test.ts
git commit -m "feat: submission readiness module and check_submission_readiness tool"
```

---

### Task 7: `prepare_app_store_version` tool

**Files:**
- Modify: `src/capabilities/tools/release.ts`, `src/capabilities/index.ts`
- Test: `tests/unit/release-tools.test.ts` (append)

**Interfaces:**
- Consumes: release client reads/writes, `EDITABLE_STATES` from `readiness.js`, `StepOutcome`.
- Produces: `prepareAppStoreVersionTool`. Result shape `{ versionId, versionString, steps: StepOutcome[] }`; `isError` set when any step failed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/release-tools.test.ts`:

```ts
describe('prepare_app_store_version', () => {
  it('creates a version, attaches the build, sets whatsNew, and enables phased release', async () => {
    const fake = emptyFakeRelease({
      builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
    });
    const { client } = await setupRelease(fake);
    const result = json(
      await call(client, 'prepare_app_store_version', {
        versionString: '2.4.0',
        buildId: 'build-2',
        whatsNew: 'Bug fixes.',
        releaseType: 'AFTER_APPROVAL',
        phased: true,
      }),
    );
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'version', status: 'done' }),
      expect.objectContaining({ step: 'attach-build', status: 'done' }),
      expect.objectContaining({ step: 'whats-new', status: 'failed' }), // no localization exists in this fake
      expect.objectContaining({ step: 'phased-release', status: 'done' }),
    ]);
    expect(fake.calls).toContain('createVersion:2.4.0:AFTER_APPROVAL');
    expect(fake.calls).toContain('setVersionBuild:v-new-1:build-2');
  });

  it('is idempotent: re-running updates the existing version in place', async () => {
    const fake = emptyFakeRelease({
      versions: [
        { id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION', releaseType: 'AFTER_APPROVAL', buildId: 'build-2' },
      ],
      builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
      localizations: new Map([['v-1', [{ id: 'loc-1', locale: 'en-US' }]]]),
    });
    const { client } = await setupRelease(fake);
    const result = json(
      await call(client, 'prepare_app_store_version', {
        versionString: '2.4.0',
        buildId: 'build-2',
        whatsNew: 'Bug fixes.',
        releaseType: 'MANUAL',
      }),
    );
    expect(result.versionId).toBe('v-1');
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'version', status: 'done', detail: expect.stringMatching(/releaseType/) }),
      expect.objectContaining({ step: 'attach-build', status: 'skipped' }),
      expect.objectContaining({ step: 'whats-new', status: 'done' }),
      expect.objectContaining({ step: 'phased-release', status: 'skipped' }),
    ]);
    expect(fake.calls).toContain('updateVersion:v-1:MANUAL');
    expect(fake.calls).toContain('updateLocalization:loc-1:Bug fixes.');
    expect(fake.calls).not.toContain('createVersion:2.4.0:MANUAL');
  });

  it('refuses to reuse a version that exists in a non-editable state', async () => {
    const fake = emptyFakeRelease({
      versions: [{ id: 'v-1', versionString: '2.4.0', state: 'READY_FOR_SALE' }],
    });
    const { client } = await setupRelease(fake);
    const result = await call(client, 'prepare_app_store_version', { versionString: '2.4.0' });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/READY_FOR_SALE/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/release-tools.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement the tool in `src/capabilities/tools/release.ts`**

Add `EDITABLE_STATES` to the readiness import. Then:

```ts
const releaseTypeSchema = z
  .enum(['AFTER_APPROVAL', 'MANUAL', 'SCHEDULED'])
  .describe('How the version goes live after approval (default AFTER_APPROVAL)');

export const prepareAppStoreVersionTool = defineTool({
  name: 'prepare_app_store_version',
  title: 'Prepare App Store version',
  description:
    'Creates or updates an App Store version, optionally attaches a build, sets what\'s-new text, ' +
    'and enables phased release. Idempotent: re-running updates in place and skips completed steps. ' +
    'Heavy metadata (description, screenshots, privacy) is managed in App Store Connect — ' +
    'check_submission_readiness reports what is missing there.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    versionString: z.string().describe('Marketing version, e.g. "2.4.0"'),
    buildId: z.string().optional().describe('Build to attach (from list_builds)'),
    whatsNew: z.string().optional().describe("What's-new release notes for the primary localization"),
    releaseType: releaseTypeSchema.optional(),
    phased: z.boolean().optional().describe('Enable 7-day phased release (default false)'),
    platform: z.string().optional().describe('Platform (default "IOS")'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  handler: async ({ appId, versionString, buildId, whatsNew, releaseType, phased, platform }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const wantedType = releaseType ?? 'AFTER_APPROVAL';
    const steps: StepOutcome[] = [];

    // Step: version (create or update in place).
    const versions = await release.listVersions(resolved, { platform, limit: 20 }, ctx.signal);
    let version = versions.find((v) => v.versionString === versionString);
    if (version && version.state && !EDITABLE_STATES.includes(version.state)) {
      throw new Error(
        `Version ${versionString} already exists in state ${version.state} and cannot be edited. ` +
          'Use a new versionString.',
      );
    }
    if (!version) {
      version = await release.createVersion(
        resolved,
        { versionString, platform: platform ?? 'IOS', releaseType: wantedType },
        ctx.signal,
      );
      steps.push({ step: 'version', status: 'done', detail: `Created version ${versionString}.` });
    } else if (version.releaseType !== wantedType) {
      await release.updateVersion(version.id, { releaseType: wantedType }, ctx.signal);
      steps.push({ step: 'version', status: 'done', detail: `Updated releaseType to ${wantedType}.` });
    } else {
      steps.push({ step: 'version', status: 'skipped', detail: 'Version already up to date.' });
    }

    // Step: attach-build.
    if (!buildId) {
      steps.push({ step: 'attach-build', status: 'skipped', detail: 'No buildId given.' });
    } else if (version.buildId === buildId) {
      steps.push({ step: 'attach-build', status: 'skipped', detail: 'Build already attached.' });
    } else {
      await release.setVersionBuild(version.id, buildId, ctx.signal);
      steps.push({ step: 'attach-build', status: 'done', detail: `Attached build ${buildId}.` });
    }

    // Step: whats-new (primary localization = first returned).
    if (!whatsNew) {
      steps.push({ step: 'whats-new', status: 'skipped', detail: 'No whatsNew given.' });
    } else {
      const localizations = await release.getVersionLocalizations(version.id, ctx.signal);
      const primary = localizations[0];
      if (!primary) {
        steps.push({
          step: 'whats-new',
          status: 'failed',
          detail: 'Version has no localizations yet — add one in App Store Connect, then re-run.',
        });
      } else {
        await release.updateLocalization(primary.id, { whatsNew }, ctx.signal);
        steps.push({ step: 'whats-new', status: 'done', detail: `Set what's-new for ${primary.locale ?? 'primary'}.` });
      }
    }

    // Step: phased-release.
    if (!phased) {
      steps.push({ step: 'phased-release', status: 'skipped', detail: 'Phased release not requested.' });
    } else {
      const existing = await release.getPhasedRelease(version.id, ctx.signal);
      if (existing) {
        steps.push({ step: 'phased-release', status: 'skipped', detail: 'Phased release already configured.' });
      } else {
        await release.createPhasedRelease(version.id, ctx.signal);
        steps.push({ step: 'phased-release', status: 'done', detail: 'Phased release enabled.' });
      }
    }

    const failed = steps.some((s) => s.status === 'failed');
    const result = jsonResult({ versionId: version.id, versionString, steps });
    return failed ? { ...result, isError: true } : result;
  },
});
```

Register `prepareAppStoreVersionTool` in `src/capabilities/index.ts`.

- [ ] **Step 4: Run, full suite, commit**

Run: `npx vitest run tests/unit/release-tools.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/capabilities/tools/release.ts src/capabilities/index.ts tests/unit/release-tools.test.ts
git commit -m "feat: prepare_app_store_version tool (idempotent version+build+notes)"
```

---

### Task 8: `distribute_build` tool

**Files:**
- Modify: `src/capabilities/tools/release.ts`, `src/capabilities/index.ts`
- Test: `tests/unit/release-tools.test.ts` (append)

**Interfaces:**
- Consumes: `getBuild`, `setExportCompliance`, `getBuildBetaDetail`, `submitForBetaReview`, `listBetaGroups`, `addBuildToBetaGroups`.
- Produces: `distributeBuildTool`. Result `{ buildId, steps: StepOutcome[] }` (`isError` when any step failed).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/release-tools.test.ts`:

```ts
describe('distribute_build', () => {
  function distributableFake(): FakeRelease {
    return emptyFakeRelease({
      builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: null }],
      betaGroups: [
        { id: 'g-int', name: 'Team', isInternalGroup: true },
        { id: 'g-ext', name: 'External Testers', isInternalGroup: false },
      ],
      betaDetails: new Map([['build-2', { id: 'bd-1', externalBuildState: 'READY_FOR_BETA_SUBMISSION' }]]),
    });
  }

  it('sets compliance, submits beta review, and assigns groups', async () => {
    const fake = distributableFake();
    const { client } = await setupRelease(fake);
    const result = json(
      await call(client, 'distribute_build', {
        buildId: 'build-2',
        groups: ['External Testers'],
        usesNonExemptEncryption: false,
      }),
    );
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'export-compliance', status: 'done' }),
      expect.objectContaining({ step: 'beta-review', status: 'done' }),
      expect.objectContaining({ step: 'assign-groups', status: 'done' }),
    ]);
    expect(fake.calls).toContain('setExportCompliance:build-2:false');
    expect(fake.calls).toContain('submitForBetaReview:build-2');
    expect(fake.calls).toContain('addBuildToBetaGroups:build-2:g-ext');
  });

  it('fails the compliance step when unanswered and no parameter given', async () => {
    const fake = distributableFake();
    const { client } = await setupRelease(fake);
    const result = await call(client, 'distribute_build', { buildId: 'build-2', groups: ['Team'] });
    expect(result.isError).toBe(true);
    const parsed = json(result);
    expect(parsed.steps[0]).toMatchObject({ step: 'export-compliance', status: 'failed' });
    expect(parsed.steps[0].detail).toMatch(/usesNonExemptEncryption/);
  });

  it('skips completed steps on re-run (idempotent resume)', async () => {
    const fake = distributableFake();
    fake.builds[0]!.usesNonExemptEncryption = false;
    fake.betaDetails.set('build-2', { id: 'bd-1', externalBuildState: 'IN_BETA_REVIEW' });
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'distribute_build', { buildId: 'build-2', groups: ['External Testers'] }));
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'export-compliance', status: 'skipped' }),
      expect.objectContaining({ step: 'beta-review', status: 'skipped' }),
      expect.objectContaining({ step: 'assign-groups', status: 'done' }),
    ]);
  });

  it('fails group resolution with the available names', async () => {
    const fake = distributableFake();
    fake.builds[0]!.usesNonExemptEncryption = false;
    const { client } = await setupRelease(fake);
    const result = await call(client, 'distribute_build', { buildId: 'build-2', groups: ['Nope'] });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/External Testers/);
  });

  it('skips beta review when only internal groups are targeted', async () => {
    const fake = distributableFake();
    fake.builds[0]!.usesNonExemptEncryption = false;
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'distribute_build', { buildId: 'build-2', groups: ['Team'] }));
    expect(result.steps[1]).toMatchObject({ step: 'beta-review', status: 'skipped' });
    expect(fake.calls).not.toContain('submitForBetaReview:build-2');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/release-tools.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement in `src/capabilities/tools/release.ts`**

```ts
/** External beta states that mean review is already submitted or done. */
const BETA_REVIEW_DONE_STATES = [
  'WAITING_FOR_BETA_REVIEW',
  'IN_BETA_REVIEW',
  'BETA_APPROVED',
  'READY_FOR_BETA_TESTING',
  'IN_BETA_TESTING',
];

export const distributeBuildTool = defineTool({
  name: 'distribute_build',
  title: 'Distribute build to TestFlight groups',
  description:
    'Takes an already-uploaded build to testers: declares export compliance (if needed), submits ' +
    'for external beta review (if an external group is targeted), and assigns the build to beta ' +
    'groups. Idempotent — completed steps are skipped on re-run. Reports per-step outcomes.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    buildId: z.string().describe('Build to distribute (from list_builds)'),
    groups: z.array(z.string()).min(1).describe('Beta group names to assign the build to'),
    usesNonExemptEncryption: z
      .boolean()
      .optional()
      .describe('Encryption declaration; required if the build has none yet (false = only exempt encryption)'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  handler: async ({ appId, buildId, groups, usesNonExemptEncryption }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const steps: StepOutcome[] = [];

    const build = await release.getBuild(buildId, ctx.signal);
    if (!build) throw new Error(`Build "${buildId}" not found. Use list_builds to see available builds.`);

    // Step: export-compliance.
    if (build.usesNonExemptEncryption !== null && build.usesNonExemptEncryption !== undefined) {
      steps.push({ step: 'export-compliance', status: 'skipped', detail: 'Already declared.' });
    } else if (usesNonExemptEncryption === undefined) {
      steps.push({
        step: 'export-compliance',
        status: 'failed',
        detail:
          'Build has no encryption declaration. Pass usesNonExemptEncryption (false when the app ' +
          'only uses exempt encryption like HTTPS).',
      });
    } else {
      await release.setExportCompliance(buildId, usesNonExemptEncryption, ctx.signal);
      steps.push({ step: 'export-compliance', status: 'done', detail: `Declared usesNonExemptEncryption=${String(usesNonExemptEncryption)}.` });
    }

    // Resolve group names → ids before the remaining steps.
    const available = await release.listBetaGroups(resolved, ctx.signal);
    const wanted = groups.map((name) => ({
      name,
      group: available.find((g) => g.name === name),
    }));
    const missing = wanted.filter((w) => !w.group).map((w) => w.name);
    if (missing.length > 0) {
      throw new Error(
        `Unknown beta group(s): ${missing.join(', ')}. Available: ${available.map((g) => g.name).filter(Boolean).join(', ') || '(none)'}.`,
      );
    }
    const resolvedGroups = wanted.map((w) => w.group!);
    const needsExternal = resolvedGroups.some((g) => g.isInternalGroup === false);

    // Step: beta-review (only external groups need it).
    if (!needsExternal) {
      steps.push({ step: 'beta-review', status: 'skipped', detail: 'Only internal groups targeted.' });
    } else {
      const detail = await release.getBuildBetaDetail(buildId, ctx.signal);
      const state = detail?.externalBuildState;
      if (state && BETA_REVIEW_DONE_STATES.includes(state)) {
        steps.push({ step: 'beta-review', status: 'skipped', detail: `External state is ${state}.` });
      } else if (steps.some((s) => s.step === 'export-compliance' && s.status === 'failed')) {
        steps.push({ step: 'beta-review', status: 'failed', detail: 'Blocked on export compliance.' });
      } else {
        await release.submitForBetaReview(buildId, ctx.signal);
        steps.push({ step: 'beta-review', status: 'done', detail: 'Submitted for beta review.' });
      }
    }

    // Step: assign-groups.
    await release.addBuildToBetaGroups(buildId, resolvedGroups.map((g) => g.id), ctx.signal);
    steps.push({
      step: 'assign-groups',
      status: 'done',
      detail: `Assigned to: ${resolvedGroups.map((g) => g.name).join(', ')}.`,
    });

    const failed = steps.some((s) => s.status === 'failed');
    const result = jsonResult({ buildId, steps });
    return failed ? { ...result, isError: true } : result;
  },
});
```

Register `distributeBuildTool` in `src/capabilities/index.ts`.

- [ ] **Step 4: Run, full suite, commit**

Run: `npx vitest run tests/unit/release-tools.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/capabilities/tools/release.ts src/capabilities/index.ts tests/unit/release-tools.test.ts
git commit -m "feat: distribute_build tool (compliance + beta review + group assignment)"
```

---

### Task 9: `submit_for_review` (preflight gate) + `release_version` tools

**Files:**
- Modify: `src/capabilities/tools/release.ts`, `src/capabilities/index.ts`
- Test: `tests/unit/release-tools.test.ts` (append)

**Interfaces:**
- Consumes: `gatherReadinessFacts` + `buildReadinessReport` (Task 6), review-submission writes (Task 3), `AscApiError` for 409 mapping.
- Produces: `submitForReviewTool`, `releaseVersionTool`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/release-tools.test.ts` (reuse the ready fixture from Task 6's protocol test):

```ts
function readyFake(): FakeRelease {
  return emptyFakeRelease({
    versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION', buildId: 'build-2', buildVersion: '422' }],
    builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
    localizations: new Map([['v-1', [{ id: 'loc-1', locale: 'en-US', description: 'A great app.', whatsNew: 'Fixes.' }]]]),
    screenshotSets: new Map([['loc-1', [{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 3 }]]]),
    reviewDetails: new Map([['v-1', { id: 'rd-1', contactEmail: 'dev@example.com' }]]),
    appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/p', ageRating: { declared: true } },
  });
}

describe('submit_for_review', () => {
  it('refuses with the failing checks when not ready', async () => {
    const { client } = await setupRelease(emptyFakeRelease());
    const result = await call(client, 'submit_for_review', {});
    expect(result.isError).toBe(true);
    const parsed = json(result);
    expect(parsed.submitted).toBe(false);
    expect(parsed.report.checks.some((c: { status: string }) => c.status === 'fail')).toBe(true);
  });

  it('submits when ready: create submission, add item, submit', async () => {
    const fake = readyFake();
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'submit_for_review', {}));
    expect(result.submitted).toBe(true);
    expect(result.reviewSubmissionId).toBe('rs-1');
    expect(fake.calls).toContain('createReviewSubmission:IOS');
    expect(fake.calls).toContain('addReviewSubmissionItem:rs-1:v-1');
    expect(fake.calls).toContain('submitReviewSubmission:rs-1');
  });

  it('force bypasses a failing readiness report', async () => {
    const fake = readyFake();
    fake.appInfo = { appInfoId: 'info-1', ageRating: { declared: false } }; // privacy + age rating now fail
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'submit_for_review', { force: true }));
    expect(result.submitted).toBe(true);
  });

  it('points at get_release_status when a submission is already in flight', async () => {
    const fake = readyFake();
    fake.reviewSubmissions = [{ id: 'rs-0', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }];
    const { client } = await setupRelease(fake);
    const result = await call(client, 'submit_for_review', {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/get_release_status/);
  });

  it('reuses an existing unsubmitted submission instead of creating another', async () => {
    const fake = readyFake();
    fake.reviewSubmissions = [{ id: 'rs-0', state: 'READY_FOR_REVIEW', platform: 'IOS' }];
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'submit_for_review', {}));
    expect(result.reviewSubmissionId).toBe('rs-0');
    expect(fake.calls).not.toContain('createReviewSubmission:IOS');
    expect(fake.calls).toContain('submitReviewSubmission:rs-0');
  });
});

describe('release_version', () => {
  it('releases a version pending developer release', async () => {
    const fake = emptyFakeRelease({
      versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PENDING_DEVELOPER_RELEASE' }],
    });
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'release_version', {}));
    expect(result.released).toMatchObject({ versionId: 'v-1', versionString: '2.4.0' });
    expect(fake.calls).toContain('createReleaseRequest:v-1');
  });

  it('errors when nothing is pending release', async () => {
    const { client } = await setupRelease(emptyFakeRelease());
    const result = await call(client, 'release_version', {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/PENDING_DEVELOPER_RELEASE/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/release-tools.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement both tools in `src/capabilities/tools/release.ts`**

```ts
/** Review-submission states that mean "already in Apple's queue". */
const SUBMISSION_IN_FLIGHT_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'];

export const submitForReviewTool = defineTool({
  name: 'submit_for_review',
  title: 'Submit for App Store review',
  description:
    'Submits the prepared App Store version to Apple review. Runs check_submission_readiness first ' +
    'and refuses (returning the failing checks) unless force:true. Reuses an existing unsubmitted ' +
    'review submission when present.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    platform: z.string().optional().describe('Platform (default "IOS")'),
    force: z.boolean().optional().describe('Submit even if readiness checks fail (default false)'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async ({ appId, platform, force }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const targetPlatform = platform ?? 'IOS';

    const facts = await gatherReadinessFacts(release, resolved, targetPlatform, ctx.signal);
    const report = buildReadinessReport(facts);
    if (!report.ready && !force) {
      return {
        ...jsonResult({
          submitted: false,
          reason: 'Readiness checks are failing. Fix them (or pass force:true to submit anyway).',
          report,
        }),
        isError: true,
      };
    }
    if (!report.versionId) {
      throw new Error('No editable App Store version to submit. Create one with prepare_app_store_version.');
    }

    const existing = await release.listReviewSubmissions(resolved, { limit: 10 }, ctx.signal);
    const inFlight = existing.find((s) => s.state && SUBMISSION_IN_FLIGHT_STATES.includes(s.state));
    if (inFlight) {
      throw new Error(
        `A review submission is already ${inFlight.state}. Track it with get_release_status; ` +
          'cancel it in App Store Connect if you need to restart.',
      );
    }

    const steps: StepOutcome[] = [];
    let submission = existing.find((s) => s.state === 'READY_FOR_REVIEW');
    if (submission) {
      steps.push({ step: 'create-submission', status: 'skipped', detail: `Reusing ${submission.id}.` });
    } else {
      submission = await release.createReviewSubmission(resolved, targetPlatform, ctx.signal);
      steps.push({ step: 'create-submission', status: 'done', detail: submission.id });
    }

    try {
      await release.addReviewSubmissionItem(submission.id, report.versionId, ctx.signal);
      steps.push({ step: 'add-item', status: 'done', detail: `Version ${report.versionString ?? report.versionId}.` });
    } catch (err) {
      // Apple 409s when the version is already an item of this submission — that is resume, not failure.
      if (err instanceof AscApiError && err.status === 409) {
        steps.push({ step: 'add-item', status: 'skipped', detail: 'Version already in the submission.' });
      } else {
        throw err;
      }
    }

    const submitted = await release.submitReviewSubmission(submission.id, ctx.signal);
    steps.push({ step: 'submit', status: 'done', detail: `State: ${submitted.state ?? 'submitted'}.` });

    return jsonResult({
      submitted: true,
      reviewSubmissionId: submission.id,
      versionId: report.versionId,
      forced: Boolean(force && !report.ready),
      steps,
    });
  },
});

export const releaseVersionTool = defineTool({
  name: 'release_version',
  title: 'Release approved version',
  description:
    'Releases an approved, manually-held App Store version (state PENDING_DEVELOPER_RELEASE) to ' +
    'production. Only needed when the version was prepared with releaseType MANUAL.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async ({ appId }, ctx) => {
    const release = requireRelease(ctx);
    const versions = await release.listVersions(resolveAppId(appId, ctx), { limit: 10 }, ctx.signal);
    const pending = versions.find((v) => v.state === 'PENDING_DEVELOPER_RELEASE');
    if (!pending) {
      throw new Error(
        'No version in state PENDING_DEVELOPER_RELEASE. Check get_release_status — the version may ' +
          'still be in review, or was prepared with releaseType AFTER_APPROVAL.',
      );
    }
    await release.createReleaseRequest(pending.id, ctx.signal);
    return jsonResult({ released: { versionId: pending.id, versionString: pending.versionString } });
  },
});
```

Add `import { AscApiError } from '../../asc/types.js';` to the file's imports. Register both tools in `src/capabilities/index.ts`.

- [ ] **Step 4: Run, full suite, commit**

Run: `npx vitest run tests/unit/release-tools.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/capabilities/tools/release.ts src/capabilities/index.ts tests/unit/release-tools.test.ts
git commit -m "feat: submit_for_review with readiness preflight gate and release_version tool"
```

---

### Task 10: Audit types, engine, and the v1 guideline rule pack

**Files:**
- Create: `src/audit/types.ts`, `src/audit/engine.ts`, `src/audit/guidelines/privacy.ts`, `src/audit/guidelines/metadata.ts`, `src/audit/guidelines/payments.ts`, `src/audit/guidelines/completeness.ts`, `src/audit/guidelines/index.ts`
- Test: `tests/unit/audit-engine.test.ts` (create)

**Interfaces:**
- Consumes: nothing from ASC — this layer is pure functions over `AppFacts`.
- Produces (Tasks 11–13 depend on these exact shapes):

```ts
// src/audit/types.ts
export interface ProjectFacts { infoPlistPaths: string[]; purposeStrings: Record<string, string>; entitlementKeys: string[]; privacyManifestFound: boolean; warnings: string[]; }
export interface AppFacts {
  appId: string;
  hasSubscriptions: boolean;
  hasCustomEula: boolean;
  privacyPolicyUrl?: string;
  ageRating: { declared: boolean; inAppControls?: string | null };
  descriptions: { locale?: string; text?: string }[];
  project?: ProjectFacts;
}
export type FindingStatus = 'pass' | 'fail' | 'warn' | 'needs_judgment';
export interface CheckOutcome { status: FindingStatus; detail: string; facts?: unknown; }
export interface Finding { ruleId: string; guideline: string; title: string; link: string; status: FindingStatus; detail: string; facts?: unknown; judgment?: { question: string; guidance: string }; fix: string; }
export interface SkippedCheck { ruleId: string; guideline: string; reason: string; }
export interface GuidelineRule { id: string; guideline: string; title: string; link: string; needsProject?: boolean; tools?: string[]; appliesTo(facts: AppFacts): boolean; check?(facts: AppFacts): CheckOutcome; judgment?: { question: string; guidance: string }; fix: string; }
// src/audit/engine.ts
export function runAudit(rules: GuidelineRule[], facts: AppFacts): { findings: Finding[]; skippedChecks: SkippedCheck[] }
// src/audit/guidelines/index.ts
export const guidelineRules: GuidelineRule[];
export const RULE_PACK_LAST_REVIEWED = '2026-08-13';
```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/audit-engine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runAudit } from '../../src/audit/engine.js';
import { guidelineRules, RULE_PACK_LAST_REVIEWED } from '../../src/audit/guidelines/index.js';
import type { AppFacts, ProjectFacts } from '../../src/audit/types.js';

function baseFacts(overrides: Partial<AppFacts> = {}): AppFacts {
  return {
    appId: 'app-1',
    hasSubscriptions: false,
    hasCustomEula: false,
    privacyPolicyUrl: 'https://example.com/privacy',
    ageRating: { declared: true, inAppControls: 'NONE' },
    descriptions: [{ locale: 'en-US', text: 'A great app.' }],
    ...overrides,
  };
}

function projectFacts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    infoPlistPaths: ['/proj/App/Info.plist'],
    purposeStrings: { NSCameraUsageDescription: 'Scans recipes so you can save them as cards.' },
    entitlementKeys: [],
    privacyManifestFound: true,
    warnings: [],
    ...overrides,
  };
}

function finding(result: ReturnType<typeof runAudit>, ruleId: string) {
  const found = result.findings.find((f) => f.ruleId === ruleId);
  if (!found) throw new Error(`no finding ${ruleId}`);
  return found;
}

describe('rule pack metadata', () => {
  it('exposes a lastReviewed date and links on every rule', () => {
    expect(RULE_PACK_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const rule of guidelineRules) {
      expect(rule.link).toMatch(/^https:\/\/developer\.apple\.com\//);
      expect(rule.fix.length).toBeGreaterThan(10);
    }
  });
});

describe('project-dependent rules', () => {
  it('are skipped (not silently dropped) without project facts', () => {
    const result = runAudit(guidelineRules, baseFacts());
    const skippedIds = result.skippedChecks.map((s) => s.ruleId);
    expect(skippedIds).toContain('privacy.purpose-strings');
    expect(skippedIds).toContain('privacy.manifest-present');
    expect(result.findings.map((f) => f.ruleId)).not.toContain('privacy.purpose-strings');
  });

  it('purpose strings: empty value fails, non-empty needs judgment with facts attached', () => {
    const empty = runAudit(
      guidelineRules,
      baseFacts({ project: projectFacts({ purposeStrings: { NSPhotoLibraryUsageDescription: '  ' } }) }),
    );
    expect(finding(empty, 'privacy.purpose-strings')).toMatchObject({ status: 'fail' });
    expect(finding(empty, 'privacy.purpose-strings').detail).toMatch(/NSPhotoLibraryUsageDescription/);

    const quality = runAudit(guidelineRules, baseFacts({ project: projectFacts() }));
    const f = finding(quality, 'privacy.purpose-strings');
    expect(f.status).toBe('needs_judgment');
    expect(f.judgment?.guidance).toMatch(/microphone access/);
    expect(f.facts).toMatchObject({ NSCameraUsageDescription: expect.stringContaining('recipes') });
  });

  it('account deletion applies only with the Sign in with Apple entitlement', () => {
    const without = runAudit(guidelineRules, baseFacts({ project: projectFacts() }));
    expect(without.findings.map((f) => f.ruleId)).not.toContain('privacy.account-deletion');

    const withSiwa = runAudit(
      guidelineRules,
      baseFacts({ project: projectFacts({ entitlementKeys: ['com.apple.developer.applesignin'] }) }),
    );
    expect(finding(withSiwa, 'privacy.account-deletion').status).toBe('needs_judgment');
  });

  it('privacy manifest missing is a warn', () => {
    const result = runAudit(
      guidelineRules,
      baseFacts({ project: projectFacts({ privacyManifestFound: false }) }),
    );
    expect(finding(result, 'privacy.manifest-present').status).toBe('warn');
  });
});

describe('metadata rules', () => {
  it('fails when the age rating is undeclared', () => {
    const result = runAudit(guidelineRules, baseFacts({ ageRating: { declared: false } }));
    expect(finding(result, 'metadata.age-rating-declared').status).toBe('fail');
  });

  it('flags declared In-App Controls for judgment (guideline 2.3.6)', () => {
    const none = runAudit(guidelineRules, baseFacts());
    expect(none.findings.map((f) => f.ruleId)).not.toContain('metadata.in-app-controls');

    const declared = runAudit(
      guidelineRules,
      baseFacts({ ageRating: { declared: true, inAppControls: 'PARENTAL_CONTROLS' } }),
    );
    expect(finding(declared, 'metadata.in-app-controls')).toMatchObject({
      status: 'needs_judgment',
      guideline: '2.3.6',
    });
  });
});

describe('payments rules', () => {
  it('subscriptions without a Terms of Use link in the description fail 3.1.2', () => {
    const result = runAudit(guidelineRules, baseFacts({ hasSubscriptions: true }));
    expect(finding(result, 'payments.subscription-terms').status).toBe('fail');
  });

  it('passes with a Terms link in the description or a custom EULA', () => {
    const viaLink = runAudit(
      guidelineRules,
      baseFacts({
        hasSubscriptions: true,
        descriptions: [{ locale: 'en-US', text: 'Terms of Use: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' }],
      }),
    );
    expect(finding(viaLink, 'payments.subscription-terms').status).toBe('pass');

    const viaEula = runAudit(guidelineRules, baseFacts({ hasSubscriptions: true, hasCustomEula: true }));
    expect(finding(viaEula, 'payments.subscription-terms').status).toBe('pass');
  });

  it('does not apply payments rules to apps without subscriptions', () => {
    const result = runAudit(guidelineRules, baseFacts());
    expect(result.findings.map((f) => f.ruleId)).not.toContain('payments.subscription-terms');
  });
});

describe('completeness rules', () => {
  it('always raises the demo-account judgment item (guideline 2.1)', () => {
    const result = runAudit(guidelineRules, baseFacts());
    expect(finding(result, 'completeness.demo-account').status).toBe('needs_judgment');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/audit-engine.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/audit/types.ts`**

Exactly the block from **Interfaces** above, with a header comment:

```ts
/**
 * Audit domain types.
 *
 * `AppFacts` is the single input every guideline rule sees: ASC metadata plus
 * (optionally) facts scanned from the local Xcode project. Rules are data +
 * two small functions; the deterministic `check` handles mechanical
 * requirements, while `judgment` items carry the facts and Apple's guidance
 * for the calling LLM to evaluate — the rule pack grounds the audit, the LLM
 * does the reasoning.
 */
```

- [ ] **Step 4: Create `src/audit/engine.ts`**

```ts
/**
 * Rule evaluation: applicability filter + deterministic checks. Rules that
 * need project facts are reported as skipped (never silently dropped) when no
 * projectPath was scanned.
 */
import type { AppFacts, Finding, GuidelineRule, SkippedCheck } from './types.js';

export function runAudit(
  rules: GuidelineRule[],
  facts: AppFacts,
): { findings: Finding[]; skippedChecks: SkippedCheck[] } {
  const findings: Finding[] = [];
  const skippedChecks: SkippedCheck[] = [];

  for (const rule of rules) {
    if (rule.needsProject && !facts.project) {
      skippedChecks.push({
        ruleId: rule.id,
        guideline: rule.guideline,
        reason: 'Requires projectPath (local Xcode project scan).',
      });
      continue;
    }
    if (!rule.appliesTo(facts)) continue;

    const base = { ruleId: rule.id, guideline: rule.guideline, title: rule.title, link: rule.link, fix: rule.fix };
    if (rule.check) {
      const outcome = rule.check(facts);
      findings.push({
        ...base,
        status: outcome.status,
        detail: outcome.detail,
        facts: outcome.facts,
        ...(outcome.status === 'needs_judgment' && rule.judgment ? { judgment: rule.judgment } : {}),
      });
    } else if (rule.judgment) {
      findings.push({ ...base, status: 'needs_judgment', detail: rule.judgment.question, judgment: rule.judgment });
    }
  }
  return { findings, skippedChecks };
}
```

- [ ] **Step 5: Create the rule files**

`src/audit/guidelines/privacy.ts`:

```ts
/** Guideline 5.1.1 — privacy & data collection. */
import type { GuidelineRule } from '../types.js';

const LINK = 'https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage';

export const privacyRules: GuidelineRule[] = [
  {
    id: 'privacy.purpose-strings',
    guideline: '5.1.1(ii)',
    title: 'Purpose strings must explain use and give an example',
    link: LINK,
    needsProject: true,
    tools: ['audit_app_review'],
    appliesTo: (facts) => Object.keys(facts.project?.purposeStrings ?? {}).length > 0,
    check: (facts) => {
      const strings = facts.project?.purposeStrings ?? {};
      const empty = Object.entries(strings)
        .filter(([, value]) => !value.trim())
        .map(([key]) => key);
      if (empty.length > 0) {
        return { status: 'fail', detail: `Empty purpose strings: ${empty.join(', ')}.`, facts: strings };
      }
      return {
        status: 'needs_judgment',
        detail: 'Purpose strings are present — their quality needs review.',
        facts: strings,
      };
    },
    judgment: {
      question:
        'Does each purpose string clearly explain how the app uses the protected resource AND give a specific example?',
      guidance:
        'Apple rejects vague strings. Hypothetical strings that fail review: "App would like to access ' +
        'your Contacts", "App needs microphone access". A passing string names the feature and an ' +
        'example of use: "Uses the camera to scan handwritten recipes so you can save them as cards."',
    },
    fix:
      'Rewrite each …UsageDescription value in Info.plist to state the feature that uses the data and ' +
      'a concrete example, then rebuild and re-upload the binary.',
  },
  {
    id: 'privacy.policy-url',
    guideline: '5.1.1(i)',
    title: 'Privacy policy link required',
    link: LINK,
    tools: ['check_submission_readiness'],
    appliesTo: () => true,
    check: (facts) =>
      facts.privacyPolicyUrl
        ? { status: 'pass', detail: `Privacy policy: ${facts.privacyPolicyUrl}` }
        : { status: 'fail', detail: 'No privacy policy URL set in App Store Connect.' },
    fix: 'Add the privacy policy URL on the App Information page in App Store Connect.',
  },
  {
    id: 'privacy.account-deletion',
    guideline: '5.1.1(v)',
    title: 'Apps with account creation must offer in-app account deletion',
    link: LINK,
    needsProject: true,
    appliesTo: (facts) => (facts.project?.entitlementKeys ?? []).includes('com.apple.developer.applesignin'),
    judgment: {
      question:
        'The app has the Sign in with Apple entitlement, so it supports account creation. Can users ' +
        'initiate account deletion from within the app?',
      guidance:
        'Apple requires apps that support account creation to also let users initiate account deletion ' +
        'in-app. A link out is acceptable only if it leads directly to the deletion flow.',
    },
    fix: 'Add an in-app entry point that lets users delete their account and associated data.',
  },
  {
    id: 'privacy.manifest-present',
    guideline: '5.1.1',
    title: 'Privacy manifest (PrivacyInfo.xcprivacy) present',
    link: LINK,
    needsProject: true,
    appliesTo: () => true,
    check: (facts) =>
      facts.project?.privacyManifestFound
        ? { status: 'pass', detail: 'PrivacyInfo.xcprivacy found.' }
        : {
            status: 'warn',
            detail:
              'No PrivacyInfo.xcprivacy found. Required when the app or its SDKs use required-reason ' +
              'APIs or collect data.',
          },
    fix: 'Add a PrivacyInfo.xcprivacy manifest describing data collection and required-reason API usage.',
  },
];
```

`src/audit/guidelines/metadata.ts`:

```ts
/** Guideline 2.3 — accurate metadata. */
import type { GuidelineRule } from '../types.js';

const LINK = 'https://developer.apple.com/app-store/review/guidelines/#accurate-metadata';

export const metadataRules: GuidelineRule[] = [
  {
    id: 'metadata.age-rating-declared',
    guideline: '2.3.6',
    title: 'Age rating questionnaire completed',
    link: LINK,
    tools: ['check_submission_readiness'],
    appliesTo: () => true,
    check: (facts) =>
      facts.ageRating.declared
        ? { status: 'pass', detail: 'Age rating declared.' }
        : { status: 'fail', detail: 'Age rating questionnaire not completed in App Store Connect.' },
    fix: 'Complete the age rating questionnaire on the App Information page in App Store Connect.',
  },
  {
    id: 'metadata.in-app-controls',
    guideline: '2.3.6',
    title: 'In-App Controls declaration must match the app',
    link: LINK,
    appliesTo: (facts) => Boolean(facts.ageRating.inAppControls && facts.ageRating.inAppControls !== 'NONE'),
    judgment: {
      question:
        'The age rating declares In-App Controls (parental controls / age assurance). Does the app ' +
        'actually ship these mechanisms, and can a reviewer find them?',
      guidance:
        'Apple rejects apps whose Age Rating selects In-App Controls when reviewers cannot locate ' +
        'parental controls or age-assurance features. Either the app must ship them (and review notes ' +
        'should say where), or the selection must be set to "None".',
    },
    fix:
      'If the app ships these controls, explain where to find them in the review notes; otherwise set ' +
      '"Parental Controls" to "None" on the App Information page.',
  },
];
```

`src/audit/guidelines/payments.ts`:

```ts
/** Guideline 3.1 — payments, subscriptions. */
import type { GuidelineRule } from '../types.js';

const LINK = 'https://developer.apple.com/app-store/review/guidelines/#payments';
const TERMS_PATTERN = /terms of use|EULA|apple\.com\/legal\/internet-services\/itunes\/dev\/stdeula/i;

export const paymentsRules: GuidelineRule[] = [
  {
    id: 'payments.subscription-terms',
    guideline: '3.1.2',
    title: 'Subscriptions need a functional Terms of Use (EULA) link',
    link: LINK,
    tools: ['audit_app_review'],
    appliesTo: (facts) => facts.hasSubscriptions,
    check: (facts) => {
      if (facts.hasCustomEula) {
        return { status: 'pass', detail: 'Custom EULA configured in App Store Connect.' };
      }
      const hasLink = facts.descriptions.some((d) => d.text && TERMS_PATTERN.test(d.text));
      return hasLink
        ? { status: 'pass', detail: 'Terms of Use link found in the App Description.' }
        : {
            status: 'fail',
            detail:
              'App offers auto-renewable subscriptions but the App Description has no Terms of Use ' +
              '(EULA) link and no custom EULA is configured.',
          };
    },
    fix:
      'Using the standard Apple EULA: add a Terms of Use link (https://www.apple.com/legal/internet-services/itunes/dev/stdeula/) ' +
      'to the App Description in App Store Connect. Using a custom EULA: configure it in App Store Connect instead.',
  },
  {
    id: 'payments.external-purchase-links',
    guideline: '3.1.1',
    title: 'Digital content must use In-App Purchase',
    link: LINK,
    appliesTo: (facts) => facts.hasSubscriptions,
    judgment: {
      question:
        'Does the app unlock digital content or features through any mechanism other than In-App ' +
        'Purchase, or link out to external purchase flows without the required entitlement?',
      guidance:
        'Apps unlocking digital content must use IAP. External purchase links require the applicable ' +
        'entitlements and regional rules; steering users to external payment without them is rejected.',
    },
    fix: 'Route digital purchases through IAP, or adopt the external-purchase-link entitlements where eligible.',
  },
];
```

`src/audit/guidelines/completeness.ts`:

```ts
/** Guideline 2.1 — app completeness / information needed. */
import type { GuidelineRule } from '../types.js';

export const completenessRules: GuidelineRule[] = [
  {
    id: 'completeness.demo-account',
    guideline: '2.1',
    title: 'Reviewers must be able to access all features',
    link: 'https://developer.apple.com/app-store/review/guidelines/#app-completeness',
    appliesTo: () => true,
    judgment: {
      question:
        'Does the app require sign-in or special setup? If so, is a working demo account (or demo ' +
        'mode) provided in App Review Information?',
      guidance:
        'Guideline 2.1 rejections commonly cite inaccessible features. Reviewers cannot receive SMS ' +
        'codes or create accounts requiring external verification — provide demo credentials that ' +
        'bypass 2FA, or a fully featured demo mode.',
    },
    fix: 'Fill in demo account credentials under App Review Information for the version before submitting.',
  },
];
```

`src/audit/guidelines/index.ts`:

```ts
/**
 * The v1 rule pack. One file per guideline area; add a rule by appending to
 * the area file (or adding a new area file and spreading it here).
 * Bump RULE_PACK_LAST_REVIEWED whenever the pack is checked against Apple's
 * current guidelines — audit output surfaces it so staleness is visible.
 */
import type { GuidelineRule } from '../types.js';
import { completenessRules } from './completeness.js';
import { metadataRules } from './metadata.js';
import { paymentsRules } from './payments.js';
import { privacyRules } from './privacy.js';

export const RULE_PACK_LAST_REVIEWED = '2026-08-13';

export const guidelineRules: GuidelineRule[] = [
  ...privacyRules,
  ...metadataRules,
  ...paymentsRules,
  ...completenessRules,
];
```

- [ ] **Step 6: Run, full suite, commit**

Run: `npx vitest run tests/unit/audit-engine.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/audit/types.ts src/audit/engine.ts src/audit/guidelines/ tests/unit/audit-engine.test.ts
git commit -m "feat: audit engine and v1 App Store guideline rule pack"
```

---

### Task 11: Project scanner (`plist` dependency + fixture tree)

**Files:**
- Modify: `package.json` (via npm install)
- Create: `src/audit/project-scan.ts`
- Create: `tests/fixtures/sample-project/App/Info.plist`, `tests/fixtures/sample-project/App/App.entitlements`, `tests/fixtures/sample-project/App/PrivacyInfo.xcprivacy`, `tests/fixtures/sample-project/build/Info.plist` (decoy)
- Test: `tests/unit/project-scan.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectFacts` from `src/audit/types.js`; `plist` package.
- Produces: `scanProject(projectPath: string): Promise<ProjectFacts>` — throws a readable `Error` for an unreadable root; per-file parse failures land in `warnings`, never throw.

- [ ] **Step 1: Install the dependency**

Run: `npm install plist && npm install -D @types/plist`
Expected: both added to package.json without errors.

- [ ] **Step 2: Create the fixture tree**

`tests/fixtures/sample-project/App/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.example.sample</string>
	<key>NSCameraUsageDescription</key>
	<string>Uses the camera to scan handwritten recipes so you can save them as cards.</string>
	<key>NSPhotoLibraryUsageDescription</key>
	<string></string>
</dict>
</plist>
```

`tests/fixtures/sample-project/App/App.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.applesignin</key>
	<array>
		<string>Default</string>
	</array>
</dict>
</plist>
```

`tests/fixtures/sample-project/App/PrivacyInfo.xcprivacy`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyCollectedDataTypes</key>
	<array/>
</dict>
</plist>
```

`tests/fixtures/sample-project/build/Info.plist` (decoy — must be ignored):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSDecoyUsageDescription</key>
	<string>should never be scanned</string>
</dict>
</plist>
```

- [ ] **Step 3: Write the failing tests**

Create `tests/unit/project-scan.test.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../../src/audit/project-scan.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-project');

describe('scanProject', () => {
  it('collects purpose strings, entitlements, and the privacy manifest', async () => {
    const facts = await scanProject(FIXTURE);
    expect(facts.purposeStrings).toEqual({
      NSCameraUsageDescription: 'Uses the camera to scan handwritten recipes so you can save them as cards.',
      NSPhotoLibraryUsageDescription: '',
    });
    expect(facts.entitlementKeys).toContain('com.apple.developer.applesignin');
    expect(facts.privacyManifestFound).toBe(true);
    expect(facts.infoPlistPaths).toHaveLength(1);
    expect(facts.warnings).toEqual([]);
  });

  it('ignores build output directories', async () => {
    const facts = await scanProject(FIXTURE);
    expect(facts.purposeStrings).not.toHaveProperty('NSDecoyUsageDescription');
  });

  it('throws a readable error for a missing path', async () => {
    await expect(scanProject(join(FIXTURE, 'no-such-dir'))).rejects.toThrow(/projectPath/);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run tests/unit/project-scan.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 5: Create `src/audit/project-scan.ts`**

```ts
/**
 * Local Xcode-project scan for audit facts the ASC API cannot provide:
 * purpose strings (Info.plist), entitlements, and privacy manifests. The scan
 * degrades, never crashes the audit: unreadable/unparsable files become
 * `warnings`; only an unreadable root path throws. Info.plist purpose strings
 * are merged across app targets; every plist path found is reported so an
 * ambiguous multi-target project is visible to the caller.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import plist from 'plist';
import type { ProjectFacts } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'Pods',
  'Carthage',
  'DerivedData',
  'build',
  'Build',
  '.build',
  'dist',
]);
const MAX_DEPTH = 8;

export async function scanProject(projectPath: string): Promise<ProjectFacts> {
  const infoPlistPaths: string[] = [];
  const entitlementPaths: string[] = [];
  let privacyManifestFound = false;
  const warnings: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) {
        throw new Error(`Cannot read projectPath "${projectPath}": ${(err as Error).message}`);
      }
      warnings.push(`Unreadable directory skipped: ${dir}`);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.name === 'Info.plist') {
        infoPlistPaths.push(full);
      } else if (entry.name.endsWith('.entitlements')) {
        entitlementPaths.push(full);
      } else if (entry.name === 'PrivacyInfo.xcprivacy') {
        privacyManifestFound = true;
      }
    }
  }
  await walk(projectPath, 0);

  const purposeStrings: Record<string, string> = {};
  for (const path of infoPlistPaths) {
    const parsed = await parsePlistFile(path, warnings);
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (key.endsWith('UsageDescription') && typeof value === 'string') {
        purposeStrings[key] = value;
      }
    }
  }

  const entitlementKeys = new Set<string>();
  for (const path of entitlementPaths) {
    const parsed = await parsePlistFile(path, warnings);
    for (const key of Object.keys(parsed ?? {})) entitlementKeys.add(key);
  }

  return {
    infoPlistPaths,
    purposeStrings,
    entitlementKeys: [...entitlementKeys],
    privacyManifestFound,
    warnings,
  };
}

async function parsePlistFile(
  path: string,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = plist.parse(await readFile(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warnings.push(`Not a dictionary plist: ${path}`);
    return undefined;
  } catch (err) {
    warnings.push(`Could not parse ${path}: ${(err as Error).message}`);
    return undefined;
  }
}
```

- [ ] **Step 6: Run, full suite, commit**

Run: `npx vitest run tests/unit/project-scan.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add package.json package-lock.json src/audit/project-scan.ts tests/fixtures/sample-project tests/unit/project-scan.test.ts
git commit -m "feat: Xcode project scanner for purpose strings, entitlements, privacy manifests"
```

---

### Task 12: Facts gathering + `audit_app_review` tool

**Files:**
- Create: `src/audit/facts.ts`, `src/capabilities/tools/audit.ts`
- Modify: `src/capabilities/index.ts`
- Test: `tests/unit/audit-tools.test.ts` (create)

**Interfaces:**
- Consumes: `AscReleaseClient` reads, `EDITABLE_STATES` (readiness), `scanProject`, `runAudit`, `guidelineRules`, `RULE_PACK_LAST_REVIEWED`, `requireRelease`/`resolveAppId`/`jsonResult`.
- Produces: `gatherAppFacts(release, appId, options: { projectPath?: string; platform?: string; signal?: AbortSignal }): Promise<AppFacts>`; `auditAppReviewTool`. Audit result shape: `{ rulePack: { lastReviewed, ruleCount }, findings, skippedChecks, projectWarnings }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/audit-tools.test.ts`:

```ts
/**
 * Protocol-level tests of the audit tools with a fake release client and the
 * on-disk fixture project.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/core/container.js';
import type { CallToolResult } from '../../src/core/protocol/types.js';
import { createTestApp, McpTestClient } from '../helpers/mcp-test-client.js';
import { createTestServices, emptyFakeRelease, fakeReleaseClient, type FakeRelease } from '../helpers/fixtures.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-project');

const apps: AppContext[] = [];
afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

async function setup(fake?: FakeRelease): Promise<McpTestClient> {
  const services = createTestServices(fake ? { release: fakeReleaseClient(fake) } : {});
  const context = createTestApp({ ASC_APP_ID: 'app-1' }, { services });
  apps.push(context);
  const client = new McpTestClient(context);
  await client.initialize();
  return client;
}

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('no text content');
  return block.text;
}

function json(result: CallToolResult): any {
  return JSON.parse(firstText(result));
}

async function call(client: McpTestClient, name: string, args: unknown = {}): Promise<CallToolResult> {
  return client.request<CallToolResult>('tools/call', { name, arguments: args });
}

function subscribedFake(): FakeRelease {
  return emptyFakeRelease({
    subscriptions: true,
    appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/p', ageRating: { declared: true, inAppControls: 'NONE' } },
    versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION' }],
    localizations: new Map([['v-1', [{ id: 'loc-1', locale: 'en-US', description: 'A great app.' }]]]),
  });
}

describe('audit_app_review', () => {
  it('audits ASC metadata only, reporting project rules as skipped', async () => {
    const client = await setup(subscribedFake());
    const result = json(await call(client, 'audit_app_review'));
    expect(result.rulePack.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const byId = Object.fromEntries(result.findings.map((f: { ruleId: string }) => [f.ruleId, f]));
    expect(byId['payments.subscription-terms']).toMatchObject({ status: 'fail' });
    expect(result.skippedChecks.map((s: { ruleId: string }) => s.ruleId)).toContain('privacy.purpose-strings');
  });

  it('includes project-based findings when projectPath is given', async () => {
    const client = await setup(subscribedFake());
    const result = json(await call(client, 'audit_app_review', { projectPath: FIXTURE }));
    const purpose = result.findings.find((f: { ruleId: string }) => f.ruleId === 'privacy.purpose-strings');
    expect(purpose.status).toBe('fail'); // fixture has an empty NSPhotoLibraryUsageDescription
    expect(purpose.detail).toMatch(/NSPhotoLibraryUsageDescription/);
    const deletion = result.findings.find((f: { ruleId: string }) => f.ruleId === 'privacy.account-deletion');
    expect(deletion.status).toBe('needs_judgment');
    expect(result.skippedChecks).toEqual([]);
  });

  it('errors readably on a bad projectPath', async () => {
    const client = await setup(subscribedFake());
    const result = await call(client, 'audit_app_review', { projectPath: '/no/such/dir' });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/projectPath/);
  });

  it('explains missing ASC configuration', async () => {
    const client = await setup();
    const result = await call(client, 'audit_app_review');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/ASC_ISSUER_ID/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/audit-tools.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Create `src/audit/facts.ts`**

```ts
/**
 * AppFacts gathering: parallel ASC reads plus the optional local project
 * scan. Descriptions come from the newest editable App Store version (falling
 * back to the newest version of any state) so the audit sees the metadata
 * that would actually be submitted.
 */
import type { AscReleaseClient } from '../asc/release-client.js';
import { EDITABLE_STATES } from '../asc/readiness.js';
import { scanProject } from './project-scan.js';
import type { AppFacts } from './types.js';

export async function gatherAppFacts(
  release: AscReleaseClient,
  appId: string,
  options: { projectPath?: string; platform?: string; signal?: AbortSignal } = {},
): Promise<AppFacts> {
  const { projectPath, platform, signal } = options;
  const [hasSubscriptions, hasCustomEula, appInfo, versions, project] = await Promise.all([
    release.hasSubscriptions(appId, signal),
    release.hasCustomEula(appId, signal),
    release.getAppInfo(appId, signal),
    release.listVersions(appId, { platform, limit: 10 }, signal),
    projectPath ? scanProject(projectPath) : Promise.resolve(undefined),
  ]);

  const version =
    versions.find((v) => v.state && EDITABLE_STATES.includes(v.state)) ?? versions[0];
  const localizations = version
    ? await release.getVersionLocalizations(version.id, signal)
    : [];

  return {
    appId,
    hasSubscriptions,
    hasCustomEula,
    privacyPolicyUrl: appInfo?.privacyPolicyUrl,
    ageRating: appInfo?.ageRating ?? { declared: false },
    descriptions: localizations.map((loc) => ({ locale: loc.locale, text: loc.description })),
    project,
  };
}
```

- [ ] **Step 4: Create `src/capabilities/tools/audit.ts`**

```ts
/**
 * Review-audit tools: proactive guideline audit and rejection triage. Both
 * are advisory and read-only — they never block or perform submissions. The
 * knowledge lives in src/audit/guidelines/; judgment findings carry facts +
 * guidance for the calling LLM to evaluate.
 */
import { z } from 'zod';
import { defineTool } from '../../core/registry/define.js';
import { gatherAppFacts } from '../../audit/facts.js';
import { runAudit } from '../../audit/engine.js';
import { guidelineRules, RULE_PACK_LAST_REVIEWED } from '../../audit/guidelines/index.js';
import { jsonResult, requireRelease, resolveAppId } from './shared.js';

export const auditAppReviewTool = defineTool({
  name: 'audit_app_review',
  title: 'Audit against App Review guidelines',
  description:
    'Audits the app against a curated App Store Review Guidelines rule pack, tailored to the ' +
    "app's nature (subscriptions, protected-resource usage, age rating…). Pass projectPath to also " +
    'check Info.plist purpose strings, entitlements, and privacy manifests. Findings with status ' +
    'needs_judgment carry the facts and guidance for you to evaluate. Advisory only — ' +
    'check_submission_readiness is the completeness gate.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    projectPath: z
      .string()
      .optional()
      .describe('Path to the local Xcode project root; enables purpose-string/entitlement checks'),
    platform: z.string().optional().describe('Platform for version metadata, e.g. "IOS"'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ appId, projectPath, platform }, ctx) => {
    const release = requireRelease(ctx);
    const facts = await gatherAppFacts(release, resolveAppId(appId, ctx), {
      projectPath,
      platform,
      signal: ctx.signal,
    });
    const { findings, skippedChecks } = runAudit(guidelineRules, facts);
    return jsonResult({
      rulePack: { lastReviewed: RULE_PACK_LAST_REVIEWED, ruleCount: guidelineRules.length },
      findings,
      skippedChecks,
      projectWarnings: facts.project?.warnings ?? [],
    });
  },
});
```

Register in `src/capabilities/index.ts`: add a `// Review audit` group registering `auditAppReviewTool` (import from `./tools/audit.js`).

- [ ] **Step 5: Run, full suite, commit**

Run: `npx vitest run tests/unit/audit-tools.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/audit/facts.ts src/capabilities/tools/audit.ts src/capabilities/index.ts tests/unit/audit-tools.test.ts
git commit -m "feat: audit_app_review tool with ASC + local-project fact gathering"
```

---

### Task 13: Rejection parser + `triage_rejection` tool

**Files:**
- Create: `src/audit/rejection-parser.ts`
- Modify: `src/capabilities/tools/audit.ts`, `src/capabilities/index.ts`
- Test: `tests/unit/rejection-parser.test.ts` (create), `tests/unit/audit-tools.test.ts` (append)

**Interfaces:**
- Consumes: `guidelineRules` for guideline-reference matching.
- Produces:

```ts
export interface RejectionItem { guideline?: string; heading: string; body: string; questions: string[]; }
export function parseRejection(text: string): RejectionItem[];
```

and `triageRejectionTool` returning `{ items: [{ guideline?, heading, replyNeeded, questions, matchedRules: [{ ruleId, title, link, fix, tools }], body }], note? }`.

- [ ] **Step 1: Write the failing parser tests**

Create `tests/unit/rejection-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRejection } from '../../src/audit/rejection-parser.js';

const SAMPLE = `App Version
Guideline 5.1.1(ii) - Legal - Privacy - Data Collection and Storage
Issue Description

One or more purpose strings in the app do not sufficiently explain the use of protected resources.

Next Steps

Update the photo library purpose string to explain how the app will use the requested information.
Guideline 2.3.6 - Performance - Accurate Metadata

Issue Description

The content description selected for the app's Age Rating indicates that the app includes In-App Controls.

Next Steps

Update the Age Rating selections to "None" for "Parental Controls."
Guideline 2.1 - Information Needed

We need additional information about how the app uses face data.

Next Steps

Provide complete and detailed responses to the following questions:

- What face data does the app collect?
- Will the face data be shared with any third parties? Where will this information be stored?
- How long will face data be retained?

The submission offers auto-renewable subscriptions but does not include a functional link to the Terms of Use (EULA) in the app's metadata.`;

describe('parseRejection', () => {
  it('splits Apple-format messages into per-guideline items', () => {
    const items = parseRejection(SAMPLE);
    expect(items.map((i) => i.guideline)).toEqual([undefined, '5.1.1(ii)', '2.3.6', '2.1']);
    expect(items[0]!.heading).toBe('Preamble');
    expect(items[1]!.heading).toBe('Guideline 5.1.1(ii) - Legal - Privacy - Data Collection and Storage');
    expect(items[1]!.body).toMatch(/purpose strings/);
  });

  it('extracts reviewer questions', () => {
    const items = parseRejection(SAMPLE);
    const infoNeeded = items.find((i) => i.guideline === '2.1')!;
    expect(infoNeeded.questions).toEqual([
      'What face data does the app collect?',
      'Will the face data be shared with any third parties? Where will this information be stored?',
      'How long will face data be retained?',
    ]);
    // Trailing unheaded content (the EULA paragraph) stays in the last item's body.
    expect(infoNeeded.body).toMatch(/Terms of Use \(EULA\)/);
  });

  it('degrades to a single item for non-Apple-format text', () => {
    const items = parseRejection('Your app was rejected for reasons.');
    expect(items).toEqual([
      { heading: 'Rejection message', body: 'Your app was rejected for reasons.', questions: [] },
    ]);
  });

  it('returns no items for empty input', () => {
    expect(parseRejection('   ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/rejection-parser.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/audit/rejection-parser.ts`**

```ts
/**
 * Parse pasted App Review rejection text into structured per-guideline items.
 * Tolerant by design: Apple's "Guideline N.N.N - Area - Topic" headers split
 * the message; anything before the first header becomes a Preamble item;
 * unrecognized formats degrade to a single unstructured item. Reviewer
 * questions (bullet lines ending in "?") are extracted so callers know a
 * written reply is expected.
 */
export interface RejectionItem {
  guideline?: string;
  heading: string;
  body: string;
  questions: string[];
}

const HEADER = /^Guideline\s+(\d+(?:\.\d+)*(?:\([a-z]+\))?)\s*(?:-\s*(.+))?$/gim;

export function parseRejection(text: string): RejectionItem[] {
  const matches = [...text.matchAll(HEADER)];
  if (matches.length === 0) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ heading: 'Rejection message', body: trimmed, questions: extractQuestions(trimmed) }];
  }

  const items: RejectionItem[] = [];
  const preamble = text.slice(0, matches[0]!.index).trim();
  if (preamble) {
    items.push({ heading: 'Preamble', body: preamble, questions: extractQuestions(preamble) });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    const body = text.slice(start, end).trim();
    const topic = match[2]?.trim();
    items.push({
      guideline: match[1],
      heading: topic ? `Guideline ${match[1]} - ${topic}` : `Guideline ${match[1]}`,
      body,
      questions: extractQuestions(body),
    });
  }
  return items;
}

function extractQuestions(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter((line) => line.endsWith('?'));
}
```

- [ ] **Step 4: Run parser tests**

Run: `npx vitest run tests/unit/rejection-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the tool**

In `src/capabilities/tools/audit.ts` add to imports:

```ts
import { parseRejection } from '../../audit/rejection-parser.js';
import type { GuidelineRule } from '../../audit/types.js';
```

and append:

```ts
/** Rules whose guideline reference matches the cited one (prefix match either way). */
function matchRules(guideline: string | undefined): GuidelineRule[] {
  if (!guideline) return [];
  return guidelineRules.filter(
    (rule) => rule.guideline.startsWith(guideline) || guideline.startsWith(rule.guideline),
  );
}

export const triageRejectionTool = defineTool({
  name: 'triage_rejection',
  title: 'Triage an App Review rejection',
  description:
    'Parses a pasted App Review rejection message into per-guideline items, maps each cited ' +
    'guideline to the audit rule pack for fix steps, and flags items that need a written reply ' +
    '(reviewer questions). Works without ASC credentials — the reasoning happens over the pasted text.',
  inputSchema: z.object({
    rejectionText: z
      .string()
      .min(1)
      .describe('The full rejection message from App Review / Resolution Center, pasted verbatim'),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ rejectionText }) => {
    const items = parseRejection(rejectionText).map((item) => ({
      guideline: item.guideline,
      heading: item.heading,
      replyNeeded: item.questions.length > 0,
      questions: item.questions,
      matchedRules: matchRules(item.guideline).map((rule) => ({
        ruleId: rule.id,
        title: rule.title,
        link: rule.link,
        fix: rule.fix,
        tools: rule.tools ?? [],
      })),
      body: item.body,
    }));
    return jsonResult({
      items,
      ...(items.some((i) => i.replyNeeded)
        ? {
            note:
              'Items with replyNeeded require a written response in App Store Connect (Resolution ' +
              'Center), not only a fix.',
          }
        : {}),
    });
  },
});
```

Register `triageRejectionTool` in `src/capabilities/index.ts` under the `// Review audit` group.

- [ ] **Step 6: Append protocol-level tests**

Append to `tests/unit/audit-tools.test.ts`:

```ts
describe('triage_rejection', () => {
  const REJECTION = `Guideline 5.1.1(ii) - Legal - Privacy - Data Collection and Storage
Update the photo library purpose string to explain how the app will use the requested information.
Guideline 2.1 - Information Needed
- What face data does the app collect?
- How long will face data be retained?`;

  it('maps cited guidelines to rules and flags reply-needed items — without ASC credentials', async () => {
    const client = await setup(); // no release client on purpose
    const result = json(await call(client, 'triage_rejection', { rejectionText: REJECTION }));
    expect(result.items).toHaveLength(2);

    const purpose = result.items[0];
    expect(purpose.guideline).toBe('5.1.1(ii)');
    expect(purpose.replyNeeded).toBe(false);
    expect(purpose.matchedRules.map((r: { ruleId: string }) => r.ruleId)).toContain('privacy.purpose-strings');

    const info = result.items[1];
    expect(info.guideline).toBe('2.1');
    expect(info.replyNeeded).toBe(true);
    expect(info.questions).toHaveLength(2);
    expect(info.matchedRules.map((r: { ruleId: string }) => r.ruleId)).toContain('completeness.demo-account');
    expect(result.note).toMatch(/written response/);
  });

  it('degrades gracefully for unknown formats', async () => {
    const client = await setup();
    const result = json(await call(client, 'triage_rejection', { rejectionText: 'Nonsense rejection.' }));
    expect(result.items).toEqual([
      expect.objectContaining({ heading: 'Rejection message', matchedRules: [], replyNeeded: false }),
    ]);
  });
});
```

- [ ] **Step 7: Run, full suite, commit**

Run: `npx vitest run tests/unit/rejection-parser.test.ts tests/unit/audit-tools.test.ts && npm test && npm run typecheck`
Expected: PASS.

```bash
git add src/audit/rejection-parser.ts src/capabilities/tools/audit.ts src/capabilities/index.ts tests/unit/rejection-parser.test.ts tests/unit/audit-tools.test.ts
git commit -m "feat: rejection parser and triage_rejection tool"
```

---

### Task 14: Documentation + final verification

**Files:**
- Modify: `README.md`
- Test: full suite + registration assertion

**Interfaces:** none new — this task documents Tasks 1–13.

- [ ] **Step 1: Extend the registration test**

In `tests/unit/capabilities.test.ts`, extend the `expect.arrayContaining([...])` list in the `'exposes the full TestFlight tool surface'` test with the nine new names:

```ts
        'list_builds',
        'get_release_status',
        'check_submission_readiness',
        'prepare_app_store_version',
        'distribute_build',
        'submit_for_review',
        'release_version',
        'audit_app_review',
        'triage_rejection',
```

Run: `npx vitest run tests/unit/capabilities.test.ts` — Expected: PASS (they are all registered by now; if any name fails, fix the registration, not the test).

- [ ] **Step 2: Update `README.md`**

In the tools section (match the existing table/list format exactly), add a "Release pipeline" group documenting the seven release tools and a "Review audit" group for the two audit tools — one row each: name, what it does, key inputs. Add two notes after the table:

> Write operations (`prepare_app_store_version`, `distribute_build`, `submit_for_review`, `release_version`) require an App Store Connect API key with the **App Manager** role; the read/feedback tools work with lesser roles.

> `audit_app_review` accepts a `projectPath` pointing at your local Xcode project to also audit Info.plist purpose strings, entitlements, and privacy manifests — these are not available via the App Store Connect API. Build upload itself is out of scope: upload with Xcode, Transporter, or CI, then take over with `list_builds`.

- [ ] **Step 3: Final verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS/clean.

- [ ] **Step 4: Commit**

```bash
git add README.md tests/unit/capabilities.test.ts
git commit -m "docs: document release-pipeline and review-audit tools"
```

---

## Verification Checklist (end state)

- `npm test` green; `npm run typecheck` clean; `npm run build` succeeds.
- `tests/unit/asc-client.test.ts` was never edited (Task 1 regression guard).
- 9 new tools listed by `tools/list` (capabilities.test.ts assertion).
- `triage_rejection` works with no ASC credentials configured.
- Only new runtime dependency is `plist`.




