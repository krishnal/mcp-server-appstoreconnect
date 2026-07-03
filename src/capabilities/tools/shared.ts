/**
 * Helpers shared by the feedback tools.
 *
 * Error convention (see core/methods/tools.ts): helpers throw plain `Error`s
 * with actionable, user-relayable messages — the dispatcher converts them to
 * `isError` tool results the calling LLM can read and act on.
 */
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AscClient } from '../../asc/client.js';
import { AscApiError, type FeedbackKind } from '../../asc/types.js';
import type { AnalyzerImage } from '../../analysis/analyzer.js';
import { analysisSchema, type FeedbackAnalysis } from '../../analysis/schema.js';
import type { CallToolResult, ContentBlock } from '../../core/protocol/types.js';
import type { CapabilityContext } from '../../core/registry/define.js';
import type { StoredFeedback } from '../../storage/feedback-store.js';

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export const ASC_NOT_CONFIGURED =
  'App Store Connect is not configured. Set ASC_ISSUER_ID, ASC_KEY_ID and one of ' +
  'ASC_PRIVATE_KEY_PATH / ASC_PRIVATE_KEY_BASE64 (see README "Credentials"), then restart the server.';

export function requireAsc(ctx: CapabilityContext): AscClient {
  const asc = ctx.services.asc;
  if (!asc) throw new Error(ASC_NOT_CONFIGURED);
  return asc;
}

/** Resolve the app to operate on: explicit argument, else ASC_APP_ID. */
export function resolveAppId(explicit: string | undefined, ctx: CapabilityContext): string {
  const appId = explicit ?? ctx.config.defaultAppId;
  if (!appId) {
    throw new Error(
      'No app specified. Pass appId (find it with the list_apps tool) or set ASC_APP_ID.',
    );
  }
  return appId;
}

/**
 * Load feedback by id: local cache first, then App Store Connect (trying
 * screenshot then crash submissions), caching on the way through.
 */
export async function loadFeedback(
  ctx: CapabilityContext,
  id: string,
): Promise<StoredFeedback | undefined> {
  const cached = ctx.services.store.getFeedback(id);
  if (cached) return cached;

  const asc = ctx.services.asc;
  if (!asc) return undefined;

  for (const kind of ['screenshot', 'crash'] as FeedbackKind[]) {
    const item = await asc.getFeedback(kind, id, ctx.signal);
    if (item) {
      ctx.services.store.upsertFeedback([item]);
      return ctx.services.store.getFeedback(id);
    }
  }
  return undefined;
}

export function notFoundMessage(id: string): string {
  return `Feedback "${id}" was not found locally or in App Store Connect. Use list_feedback to see available items.`;
}

/** Stored analysis validated back into the shared shape (undefined if stale). */
export function loadAnalysis(ctx: CapabilityContext, id: string): FeedbackAnalysis | undefined {
  const stored = ctx.services.store.getAnalysis(id);
  if (!stored) return undefined;
  const parsed = analysisSchema.safeParse(stored.analysis);
  return parsed.success ? parsed.data : undefined;
}

/** Compact list-view projection of a stored feedback item. */
export function feedbackSummary(stored: StoredFeedback, ctx: CapabilityContext) {
  const { item } = stored;
  return {
    id: item.id,
    kind: item.kind,
    createdDate: item.createdDate,
    comment: item.comment,
    buildNumber: item.buildNumber,
    device: item.device.model,
    osVersion: item.device.osVersion,
    processed: stored.processed,
    screenshotCount: item.screenshots.length,
    hasAnalysis: ctx.services.store.getAnalysis(item.id) !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Screenshot handling
// ---------------------------------------------------------------------------

const IMAGE_MEDIA_TYPES: Record<string, AnalyzerImage['mediaType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function mediaTypeForUrl(url: string): AnalyzerImage['mediaType'] {
  const match = /\.(png|jpe?g|gif|webp)(?:$|\?)/i.exec(new URL(url).pathname);
  return IMAGE_MEDIA_TYPES[match?.[1]?.toLowerCase() ?? 'png'] ?? 'image/png';
}

export function extensionForMediaType(mediaType: string): string {
  return mediaType === 'image/jpeg' ? 'jpg' : (mediaType.split('/')[1] ?? 'png');
}

export interface DownloadedScreenshot {
  idx: number;
  path: string;
  mediaType: AnalyzerImage['mediaType'];
}

/**
 * Ensure all screenshots of a feedback item exist on disk, downloading any
 * that are missing. Handles expired signed URLs by re-fetching the submission
 * once for fresh ones.
 */
export async function ensureScreenshots(
  ctx: CapabilityContext,
  stored: StoredFeedback,
): Promise<DownloadedScreenshot[]> {
  const store = ctx.services.store;
  let item = stored.item;
  if (item.kind !== 'screenshot' || item.screenshots.length === 0) {
    // Crash feedback, or nothing attached — return whatever is already local.
    return store.getScreenshots(item.id).map((shot) => ({
      idx: shot.idx,
      path: shot.localPath,
      mediaType: mediaTypeForUrl(`file:///x.${shot.localPath.split('.').pop() ?? 'png'}`),
    }));
  }

  const results: DownloadedScreenshot[] = [];
  const existing = new Map(store.getScreenshots(item.id).map((shot) => [shot.idx, shot]));
  let refreshed = false;

  for (let idx = 0; idx < item.screenshots.length; idx += 1) {
    const cached = existing.get(idx);
    if (cached && (await fileExists(cached.localPath))) {
      results.push({ idx, path: cached.localPath, mediaType: mediaTypeForUrl(cached.localPath) });
      continue;
    }

    let url = item.screenshots[idx]?.url;
    if (!url) continue;
    const mediaType = mediaTypeForUrl(url);
    const dest = join(
      ctx.config.paths.screenshotsDir,
      item.id,
      `screenshot-${idx + 1}.${extensionForMediaType(mediaType)}`,
    );

    const asc = requireAsc(ctx);
    try {
      await asc.downloadScreenshot(url, dest, ctx.signal);
    } catch (err) {
      const expired =
        err instanceof AscApiError && (err.status === 403 || err.status === 410 || err.status === 404);
      if (!expired || refreshed) throw err;
      // Signed URL expired — one re-fetch buys fresh URLs for all remaining shots.
      refreshed = true;
      const fresh = await asc.getFeedback('screenshot', item.id, ctx.signal);
      if (!fresh) throw err;
      ctx.services.store.upsertFeedback([fresh]);
      item = fresh;
      url = item.screenshots[idx]?.url;
      if (!url) continue;
      await asc.downloadScreenshot(url, dest, ctx.signal);
    }

    store.saveScreenshot({
      feedbackId: item.id,
      idx,
      localPath: dest,
      width: item.screenshots[idx]?.width,
      height: item.screenshots[idx]?.height,
    });
    results.push({ idx, path: dest, mediaType });
  }
  return results;
}

/** Cap on inline images per tool result (MCP message size hygiene). */
export const MAX_EMBEDDED_IMAGES = 3;
const MAX_EMBED_BYTES = 5 * 1024 * 1024;

export async function imageBlocks(shots: DownloadedScreenshot[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const shot of shots.slice(0, MAX_EMBEDDED_IMAGES)) {
    const data = await readFile(shot.path);
    if (data.length > MAX_EMBED_BYTES) {
      blocks.push({
        type: 'text',
        text: `[screenshot ${shot.idx + 1} too large to embed — read it from ${shot.path}]`,
      });
      continue;
    }
    blocks.push({ type: 'image', data: data.toString('base64'), mimeType: shot.mediaType });
  }
  if (shots.length > MAX_EMBEDDED_IMAGES) {
    blocks.push({
      type: 'text',
      text: `[${shots.length - MAX_EMBEDDED_IMAGES} more screenshot(s) on disk — see paths in the result]`,
    });
  }
  return blocks;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
