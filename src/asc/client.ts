/**
 * App Store Connect API client (beta feedback surface).
 *
 * Uses the official, stable App Store Connect API 4.0 endpoints:
 *   GET  /v1/apps
 *   GET  /v1/apps/{id}/betaFeedbackScreenshotSubmissions
 *   GET  /v1/apps/{id}/betaFeedbackCrashSubmissions
 *   GET  /v1/betaFeedback{Screenshot,Crash}Submissions/{id}
 *   GET  /v1/betaFeedbackCrashSubmissions/{id}/crashLog
 *
 * Reliability:
 *  - 401 → invalidate the cached JWT and retry once (key/token rotation)
 *  - 429 → honor Retry-After (bounded), bounded retries
 *  - 5xx → single retry with short backoff
 *  - JSON:API `links.next` pagination up to the caller's limit
 * Errors surface as typed {@link AscApiError} with Apple's `detail` message so
 * the calling LLM can self-correct.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'undici';
import type { Logger } from '../observability/logger.js';
import type { AscTokenProvider } from './token-provider.js';
import {
  AscApiError,
  type AppAttributes,
  type AppSummary,
  type AscErrorBody,
  type AscListResponse,
  type AscSingleResponse,
  type BuildAttributes,
  type CrashLogAttributes,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackListFilters,
  type FeedbackSubmissionAttributes,
  type AscResource,
} from './types.js';

const RESOURCE_TYPE: Record<FeedbackKind, string> = {
  screenshot: 'betaFeedbackScreenshotSubmissions',
  crash: 'betaFeedbackCrashSubmissions',
};

/** Server-side page size cap documented by Apple. */
const MAX_PAGE_SIZE = 200;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 10_000;

export interface AscClientOptions {
  baseUrl: string;
  tokenProvider: AscTokenProvider;
  logger: Logger;
}

export class AscClient {
  private readonly baseUrl: string;
  private readonly tokens: AscTokenProvider;
  private readonly logger: Logger;

  constructor(options: AscClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.tokens = options.tokenProvider;
    this.logger = options.logger;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async listApps(
    options: { bundleId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<AppSummary[]> {
    const query = new URLSearchParams({ 'fields[apps]': 'name,bundleId' });
    if (options.bundleId) query.set('filter[bundleId]', options.bundleId);
    query.set('limit', String(Math.min(options.limit ?? 50, MAX_PAGE_SIZE)));

    const body = await this.requestJson<AscListResponse<AppAttributes>>(
      `/v1/apps?${query.toString()}`,
      signal,
    );
    return body.data.map((app) => ({
      id: app.id,
      name: app.attributes?.name,
      bundleId: app.attributes?.bundleId,
    }));
  }

  /** List screenshot or crash feedback for an app, newest first by default. */
  async listFeedback(
    kind: FeedbackKind,
    appId: string,
    filters: FeedbackListFilters = {},
    signal?: AbortSignal,
  ): Promise<FeedbackItem[]> {
    const limit = filters.limit ?? 50;
    const query = new URLSearchParams();
    query.set('include', 'build');
    query.set('fields[builds]', 'version');
    query.set('sort', filters.sort ?? '-createdDate');
    query.set('limit', String(Math.min(limit, MAX_PAGE_SIZE)));
    if (filters.build) query.set('filter[build]', filters.build);
    if (filters.preReleaseVersion) {
      query.set('filter[build.preReleaseVersion]', filters.preReleaseVersion);
    }
    if (filters.deviceModel) query.set('filter[deviceModel]', filters.deviceModel);
    if (filters.osVersion) query.set('filter[osVersion]', filters.osVersion);
    if (filters.devicePlatform) query.set('filter[devicePlatform]', filters.devicePlatform);

    const items: FeedbackItem[] = [];
    let url: string | undefined =
      `/v1/apps/${encodeURIComponent(appId)}/${RESOURCE_TYPE[kind]}?${query.toString()}`;

    while (url && items.length < limit) {
      const body: AscListResponse<FeedbackSubmissionAttributes> = await this.requestJson(
        url,
        signal,
      );
      const buildVersions = indexBuildVersions(body.included);
      for (const resource of body.data) {
        if (items.length >= limit) break;
        items.push(toFeedbackItem(resource, kind, appId, buildVersions));
      }
      url = body.links?.next;
    }
    return items;
  }

  /** Fetch one feedback submission by id. Returns undefined on 404. */
  async getFeedback(
    kind: FeedbackKind,
    id: string,
    signal?: AbortSignal,
  ): Promise<FeedbackItem | undefined> {
    try {
      const body = await this.requestJson<AscSingleResponse<FeedbackSubmissionAttributes>>(
        `/v1/${RESOURCE_TYPE[kind]}/${encodeURIComponent(id)}?include=build&fields[builds]=version`,
        signal,
      );
      const buildVersions = indexBuildVersions(body.included);
      // The detail endpoint does not echo the app id; relationships may.
      const appId = relationshipId(body.data, 'app') ?? '';
      return toFeedbackItem(body.data, kind, appId, buildVersions);
    } catch (err) {
      if (err instanceof AscApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Crash log text for a crash submission (undefined when not available). */
  async getCrashLogText(id: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const body = await this.requestJson<AscSingleResponse<CrashLogAttributes>>(
        `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(id)}/crashLog?fields[betaCrashLogs]=logText`,
        signal,
      );
      return body.data.attributes?.logText;
    } catch (err) {
      if (err instanceof AscApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  /**
   * Download a screenshot from its signed CDN URL to `destPath`.
   * No Authorization header — the URL itself carries the signature, and
   * leaking an ASC bearer token to a CDN host would be a credential spill.
   */
  async downloadScreenshot(
    url: string,
    destPath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; bytes: number }> {
    const response = await request(url, { method: 'GET', signal });
    if (response.statusCode >= 400) {
      await response.body.dump();
      throw new AscApiError(
        response.statusCode === 403 || response.statusCode === 410
          ? 'Screenshot URL has expired — re-fetch the feedback item for fresh URLs'
          : `Screenshot download failed with HTTP ${response.statusCode}`,
        response.statusCode,
      );
    }
    const data = Buffer.from(await response.body.arrayBuffer());
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, data);
    return { path: destPath, bytes: data.length };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async requestJson<T>(pathOrUrl: string, signal?: AbortSignal): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;

    let attempt = 0;
    let retried401 = false;
    for (;;) {
      const token = await this.tokens.getToken();
      const response = await request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        headersTimeout: 15_000,
        bodyTimeout: 30_000,
        signal,
      });

      if (response.statusCode < 400) {
        return (await response.body.json()) as T;
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
        this.logger.debug({ url }, 'ASC 401 — refreshing token and retrying');
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
          { status: response.statusCode, attempt, delayMs },
          'ASC request rate-limited or failed upstream — retrying',
        );
        await sleep(delayMs, undefined, { signal });
        continue;
      }

      throw new AscApiError(
        detail ?? `App Store Connect API returned HTTP ${response.statusCode}`,
        response.statusCode,
        errorBody.errors?.[0]?.code,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function indexBuildVersions(included: AscResource[] | undefined): Map<string, string> {
  const versions = new Map<string, string>();
  for (const resource of included ?? []) {
    if (resource.type === 'builds') {
      const version = (resource.attributes as BuildAttributes | undefined)?.version;
      if (version) versions.set(resource.id, version);
    }
  }
  return versions;
}

function relationshipId<A>(resource: AscResource<A>, name: string): string | undefined {
  const data = resource.relationships?.[name]?.data;
  if (data && !Array.isArray(data)) return data.id;
  return undefined;
}

export function toFeedbackItem(
  resource: AscResource<FeedbackSubmissionAttributes>,
  kind: FeedbackKind,
  appId: string,
  buildVersions: Map<string, string>,
): FeedbackItem {
  const attributes = resource.attributes ?? {};
  const buildId = relationshipId(resource, 'build');
  return {
    id: resource.id,
    kind,
    appId,
    createdDate: attributes.createdDate ?? '',
    comment: attributes.comment,
    email: attributes.email,
    buildId,
    buildNumber: buildId ? buildVersions.get(buildId) : undefined,
    bundleId: attributes.buildBundleId,
    appPlatform: attributes.appPlatform,
    device: {
      model: attributes.deviceModel,
      osVersion: attributes.osVersion,
      platform: attributes.devicePlatform,
      deviceFamily: attributes.deviceFamily,
      locale: attributes.locale,
      timeZone: attributes.timeZone,
      architecture: attributes.architecture,
      connectionType: attributes.connectionType,
      batteryPercentage: attributes.batteryPercentage,
      screenWidthInPoints: attributes.screenWidthInPoints,
      screenHeightInPoints: attributes.screenHeightInPoints,
      diskBytesAvailable: attributes.diskBytesAvailable,
      diskBytesTotal: attributes.diskBytesTotal,
      appUptimeInMilliseconds: attributes.appUptimeInMilliseconds,
      pairedAppleWatch: attributes.pairedAppleWatch,
    },
    screenshots: (attributes.screenshots ?? []).filter((s) => Boolean(s.url)),
  };
}
