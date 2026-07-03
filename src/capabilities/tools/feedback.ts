/**
 * Core feedback tools: list, get, crash log, unprocessed queue, processed
 * state. Listing refreshes the local cache from App Store Connect (when
 * configured) and then answers from the cache, so processed/analysis state
 * and offline re-reads stay consistent.
 */
import { z } from 'zod';
import type { FeedbackKind } from '../../asc/types.js';
import { defineTool, type CapabilityContext } from '../../core/registry/define.js';
import {
  errorResult,
  feedbackSummary,
  jsonResult,
  loadAnalysis,
  loadFeedback,
  notFoundMessage,
  resolveAppId,
  requireAsc,
} from './shared.js';

const kindSchema = z
  .enum(['screenshot', 'crash', 'all'])
  .default('all')
  .describe('Feedback type: screenshot feedback, crash reports, or both');

async function refreshFromAsc(
  ctx: CapabilityContext,
  kind: 'screenshot' | 'crash' | 'all',
  appId: string,
  filters: {
    build?: string;
    appVersion?: string;
    deviceModel?: string;
    osVersion?: string;
    platform?: string;
    limit: number;
  },
): Promise<void> {
  const asc = ctx.services.asc;
  if (!asc) return; // local-only mode
  const kinds: FeedbackKind[] = kind === 'all' ? ['screenshot', 'crash'] : [kind];
  for (const k of kinds) {
    const items = await asc.listFeedback(
      k,
      appId,
      {
        build: filters.build,
        preReleaseVersion: filters.appVersion,
        deviceModel: filters.deviceModel,
        osVersion: filters.osVersion,
        devicePlatform: filters.platform,
        limit: filters.limit,
      },
      ctx.signal,
    );
    ctx.services.store.upsertFeedback(items);
  }
}

export const listFeedbackTool = defineTool({
  name: 'list_feedback',
  title: 'List TestFlight feedback',
  description:
    'Lists recent TestFlight feedback (screenshot feedback and/or crash reports) with filters. ' +
    'Refreshes from App Store Connect and merges local state (processed flag, analysis presence). ' +
    'Returns compact summaries — use get_feedback for full detail.',
  inputSchema: z.object({
    kind: kindSchema,
    appId: z.string().optional().describe('App Store Connect app id (default: ASC_APP_ID)'),
    build: z.string().optional().describe('Filter by build id'),
    appVersion: z.string().optional().describe('Filter by app version (pre-release version), e.g. "2.1.0"'),
    deviceModel: z.string().optional().describe('Filter by device model, e.g. "iPhone17,2"'),
    osVersion: z.string().optional().describe('Filter by OS version, e.g. "26.2"'),
    platform: z
      .enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'])
      .optional()
      .describe('Filter by device platform'),
    processed: z.boolean().optional().describe('Filter by local processed state'),
    since: z.string().optional().describe('Only feedback created on/after this ISO date'),
    until: z.string().optional().describe('Only feedback created on/before this ISO date'),
    limit: z.number().int().positive().max(200).default(25),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const localOnly = ctx.services.asc === undefined;
    const appId = localOnly ? input.appId : resolveAppId(input.appId, ctx);

    if (!localOnly && appId) {
      await refreshFromAsc(ctx, input.kind, appId, { ...input, limit: input.limit });
    }

    const stored = ctx.services.store.listLocal({
      kind: input.kind === 'all' ? undefined : input.kind,
      appId,
      processed: input.processed,
      since: input.since,
      until: input.until,
      limit: input.limit,
    });

    const items = stored
      .filter((s) => !input.deviceModel || s.item.device.model === input.deviceModel)
      .filter((s) => !input.osVersion || s.item.device.osVersion === input.osVersion)
      .map((s) => feedbackSummary(s, ctx));

    return jsonResult({
      count: items.length,
      ...(localOnly ? { note: 'App Store Connect not configured — showing local cache only.' } : {}),
      items,
    });
  },
});

export const getFeedbackTool = defineTool({
  name: 'get_feedback',
  title: 'Get feedback details',
  description:
    'Full details of one feedback item: comment, device/build context, screenshot metadata and local paths, ' +
    'stored AI analysis, generated TODO, linked issues, and processed state.',
  inputSchema: z.object({
    id: z.string().describe('Feedback id from list_feedback'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ id }, ctx) => {
    const stored = await loadFeedback(ctx, id);
    if (!stored) return errorResult(notFoundMessage(id));

    const screenshots = ctx.services.store.getScreenshots(id);
    return jsonResult({
      ...stored.item,
      processed: stored.processed,
      processedAt: stored.processedAt,
      processedNote: stored.processedNote,
      screenshots: stored.item.screenshots.map((shot, idx) => ({
        index: idx,
        width: shot.width,
        height: shot.height,
        urlExpires: shot.expirationDate,
        localPath: screenshots.find((s) => s.idx === idx)?.localPath,
      })),
      analysis: loadAnalysis(ctx, id),
      todo: ctx.services.store.getTodo(id),
      issues: ctx.services.store.getIssues(id),
    });
  },
});

export const getCrashLogTool = defineTool({
  name: 'get_crash_log',
  title: 'Get crash log',
  description: 'Fetches the crash log text for a crash feedback item from App Store Connect.',
  inputSchema: z.object({
    id: z.string().describe('Crash feedback id'),
    maxBytes: z.number().int().positive().max(500_000).default(100_000),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ id, maxBytes }, ctx) => {
    const asc = requireAsc(ctx);
    const logText = await asc.getCrashLogText(id, ctx.signal);
    if (!logText) {
      return errorResult(
        `No crash log available for "${id}". Confirm the id refers to a crash feedback item (kind "crash" in list_feedback).`,
      );
    }
    const truncated = logText.length > maxBytes;
    return {
      content: [
        {
          type: 'text',
          text: truncated ? `${logText.slice(0, maxBytes)}\n\n[truncated at ${maxBytes} bytes]` : logText,
        },
      ],
    };
  },
});

export const listUnprocessedTool = defineTool({
  name: 'list_unprocessed',
  title: 'List unprocessed feedback',
  description:
    'Quick access to feedback not yet marked processed — the triage queue. Refreshes from App Store Connect when configured.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (default: ASC_APP_ID)'),
    kind: kindSchema,
    limit: z.number().int().positive().max(200).default(25),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const localOnly = ctx.services.asc === undefined;
    const appId = localOnly ? input.appId : resolveAppId(input.appId, ctx);
    if (!localOnly && appId) {
      await refreshFromAsc(ctx, input.kind, appId, { limit: input.limit });
    }
    const stored = ctx.services.store.listLocal({
      kind: input.kind === 'all' ? undefined : input.kind,
      appId,
      processed: false,
      limit: input.limit,
    });
    return jsonResult({ count: stored.length, items: stored.map((s) => feedbackSummary(s, ctx)) });
  },
});

export const markProcessedTool = defineTool({
  name: 'mark_processed',
  title: 'Mark feedback processed',
  description: 'Marks a feedback item as processed (local state), with an optional note on the resolution.',
  inputSchema: z.object({
    id: z.string().describe('Feedback id'),
    note: z.string().optional().describe('Resolution note, e.g. "fixed in build 422" or issue key'),
  }),
  annotations: { idempotentHint: true },
  handler: async ({ id, note }, ctx) => {
    // Fetch-through so items can be marked before ever being listed locally.
    const stored = await loadFeedback(ctx, id);
    if (!stored) return errorResult(notFoundMessage(id));
    ctx.services.store.setProcessed(id, true, note);
    return jsonResult({ id, processed: true, note });
  },
});

export const markUnprocessedTool = defineTool({
  name: 'mark_unprocessed',
  title: 'Mark feedback unprocessed',
  description: 'Returns a feedback item to the unprocessed queue (local state).',
  inputSchema: z.object({ id: z.string().describe('Feedback id') }),
  annotations: { idempotentHint: true },
  handler: async ({ id }, ctx) => {
    const changed = ctx.services.store.setProcessed(id, false);
    if (!changed) return errorResult(notFoundMessage(id));
    return jsonResult({ id, processed: false });
  },
});
