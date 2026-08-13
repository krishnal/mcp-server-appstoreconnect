/**
 * Shared App Store Connect HTTP transport.
 *
 * Owns auth and reliability for every ASC call, read or write:
 *  - 401 → invalidate the cached JWT and retry once (key/token rotation)
 *  - 429 → honor Retry-After (bounded), bounded retries, any method
 *  - 5xx → bounded retries, GET only (POST/PATCH/DELETE are not retried — a 5xx after a
 *    committed write may have already applied, and retrying could duplicate it)
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

      // 5xx after a committed write (POST/PATCH/DELETE) may mean the write already landed —
      // retrying it could duplicate a create or mutate twice. Only GETs are safe to retry on 5xx.
      const retryable = response.statusCode === 429 || (method === 'GET' && response.statusCode >= 500);
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
