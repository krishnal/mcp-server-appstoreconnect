/**
 * AscClient transport behavior against a mocked upstream (undici MockAgent):
 * pagination, token refresh on 401, 429 retry, 404 mapping, and the
 * JSON:API → domain normalization.
 */
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AscClient } from '../../src/asc/client.js';
import type { AscTokenProvider } from '../../src/asc/token-provider.js';
import { AscApiError } from '../../src/asc/types.js';
import { createSilentLogger } from '../../src/observability/logger.js';

const BASE = 'https://asc.test';

class FakeTokens {
  tokens = ['token-1', 'token-2', 'token-3'];
  issued = 0;
  invalidations = 0;
  current = 'token-1';

  async getToken(): Promise<string> {
    return this.current;
  }
  invalidate(): void {
    this.invalidations += 1;
    this.current = this.tokens[Math.min(this.invalidations, this.tokens.length - 1)]!;
  }
}

let agent: MockAgent;
let original: Dispatcher;
let tokens: FakeTokens;
let client: AscClient;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  tokens = new FakeTokens();
  client = new AscClient({
    baseUrl: BASE,
    tokenProvider: tokens as unknown as AscTokenProvider,
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

const submission = (id: string) => ({
  type: 'betaFeedbackScreenshotSubmissions',
  id,
  attributes: {
    createdDate: '2026-07-01T10:00:00Z',
    comment: `comment ${id}`,
    deviceModel: 'iPhone17,2',
    osVersion: '26.1',
    devicePlatform: 'IOS',
    screenshots: [
      { url: 'https://cdn.test/shot.png', expirationDate: '2026-07-02T00:00:00Z', width: 100, height: 200 },
    ],
  },
  relationships: { build: { data: { type: 'builds', id: 'build-9' } } },
});

describe('listFeedback', () => {
  it('maps JSON:API resources to domain items with build numbers', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/betaFeedbackScreenshotSubmissions.*/, method: 'GET' })
      .reply(200, {
        data: [submission('fb-1')],
        included: [{ type: 'builds', id: 'build-9', attributes: { version: '421' } }],
      });

    const items = await client.listFeedback('screenshot', 'app-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'fb-1',
      kind: 'screenshot',
      appId: 'app-1',
      buildNumber: '421',
      comment: 'comment fb-1',
    });
    expect(items[0]!.screenshots[0]!.url).toBe('https://cdn.test/shot.png');
  });

  it('follows links.next until the limit is reached', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/betaFeedbackScreenshotSubmissions\?.*/, method: 'GET' })
      .reply(200, {
        data: [submission('fb-1')],
        links: { next: `${BASE}/v1/apps/app-1/betaFeedbackScreenshotSubmissions?cursor=abc` },
      });
    pool()
      .intercept({
        path: '/v1/apps/app-1/betaFeedbackScreenshotSubmissions?cursor=abc',
        method: 'GET',
      })
      .reply(200, { data: [submission('fb-2')] });

    const items = await client.listFeedback('screenshot', 'app-1', { limit: 10 });
    expect(items.map((i) => i.id)).toEqual(['fb-1', 'fb-2']);
  });
});

describe('error handling', () => {
  it('refreshes the token and retries once on 401', async () => {
    pool()
      .intercept({ path: /\/v1\/apps.*/, method: 'GET' })
      .reply(401, { errors: [{ status: '401', detail: 'expired token' }] });
    pool()
      .intercept({ path: /\/v1\/apps.*/, method: 'GET' })
      .reply(200, { data: [] });

    const apps = await client.listApps();
    expect(apps).toEqual([]);
    expect(tokens.invalidations).toBe(1);
  });

  it('retries on 429 honoring Retry-After', async () => {
    pool()
      .intercept({ path: /\/v1\/apps.*/, method: 'GET' })
      .reply(429, { errors: [{ status: '429', title: 'rate limited' }] }, {
        headers: { 'retry-after': '0' },
      });
    pool()
      .intercept({ path: /\/v1\/apps.*/, method: 'GET' })
      .reply(200, { data: [{ type: 'apps', id: 'app-1', attributes: { name: 'A' } }] });

    const apps = await client.listApps();
    expect(apps).toHaveLength(1);
  });

  it('surfaces Apple error details as AscApiError', async () => {
    pool()
      .intercept({ path: /\/v1\/apps.*/, method: 'GET' })
      .reply(403, { errors: [{ status: '403', detail: 'The API key does not have access' }] });

    const error = await client.listApps().then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AscApiError);
    expect(error).toMatchObject({ status: 403, message: 'The API key does not have access' });
  });

  it('returns undefined for a 404 on getFeedback', async () => {
    pool()
      .intercept({ path: /\/v1\/betaFeedbackScreenshotSubmissions\/ghost.*/, method: 'GET' })
      .reply(404, { errors: [{ status: '404' }] });

    expect(await client.getFeedback('screenshot', 'ghost')).toBeUndefined();
  });
});

describe('getCrashLogText', () => {
  it('extracts the log text', async () => {
    pool()
      .intercept({ path: /\/v1\/betaFeedbackCrashSubmissions\/crash-1\/crashLog.*/, method: 'GET' })
      .reply(200, { data: { type: 'betaCrashLogs', id: 'log-1', attributes: { logText: 'Thread 0 ...' } } });

    expect(await client.getCrashLogText('crash-1')).toBe('Thread 0 ...');
  });
});
