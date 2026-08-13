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

    const error = (await http
      .request('POST', '/v1/reviewSubmissions', { body: { data: {} } })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      )) as unknown as AscApiError;
    expect(error).toBeInstanceOf(AscApiError);
    expect(error).toMatchObject({ status: 409, message: 'A review submission already exists' });
  });

  it('appends the App Manager role hint to 403s on writes only', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1/things', method: 'POST' })
      .reply(403, { errors: [{ status: '403', detail: 'Forbidden' }] });

    const error = (await http
      .request('POST', '/v1/things', { body: { data: {} } })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/App Manager role/);
  });
});
