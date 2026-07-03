/**
 * Triage tools — deterministic, local-data-only: TODO checklists, duplicate
 * grouping, and prioritization. All operate on the cached feedback + stored
 * analyses, so run list_feedback (and ideally analyze_feedback) first.
 */
import { z } from 'zod';
import { prioritize, type PrioritizeInput } from '../../analysis/prioritize.js';
import { clusterFeedback } from '../../analysis/similarity.js';
import { generateTodoMarkdown } from '../../analysis/todo.js';
import { defineTool } from '../../core/registry/define.js';
import {
  errorResult,
  jsonResult,
  loadAnalysis,
  loadFeedback,
  notFoundMessage,
} from './shared.js';

export const generateTodoTool = defineTool({
  name: 'generate_todo',
  title: 'Generate TODO checklist',
  description:
    'Generates an actionable engineering checklist (reproduce → root-cause → fix → test → verify → close) ' +
    'for a feedback item, enriched with the stored analysis when present. Stored and returned as markdown.',
  inputSchema: z.object({
    feedbackId: z.string().describe('Feedback id'),
  }),
  annotations: { idempotentHint: true },
  handler: async ({ feedbackId }, ctx) => {
    const stored = await loadFeedback(ctx, feedbackId);
    if (!stored) return errorResult(notFoundMessage(feedbackId));

    const analysis = loadAnalysis(ctx, feedbackId);
    const screenshotPaths = ctx.services.store.getScreenshots(feedbackId).map((s) => s.localPath);
    const markdown = generateTodoMarkdown(stored.item, analysis, screenshotPaths);
    ctx.services.store.saveTodo(feedbackId, markdown);

    return { content: [{ type: 'text', text: markdown }] };
  },
});

export const groupDuplicatesTool = defineTool({
  name: 'group_duplicates',
  title: 'Group duplicate feedback',
  description:
    'Clusters similar feedback in the local cache using comment similarity plus build/device/analysis-screen signals. ' +
    'Group assignments are stored and used by prioritize_feedback. Run list_feedback first to populate the cache.',
  inputSchema: z.object({
    appId: z.string().optional().describe('Restrict to one app'),
    threshold: z
      .number()
      .min(0.1)
      .max(1)
      .default(0.55)
      .describe('Similarity threshold — lower groups more aggressively'),
  }),
  annotations: { idempotentHint: true },
  handler: async ({ appId, threshold }, ctx) => {
    const stored = ctx.services.store.listLocal({ appId, limit: 500 });
    if (stored.length === 0) {
      return errorResult('No feedback in the local cache yet — run list_feedback first.');
    }

    const clusters = clusterFeedback(
      stored.map((s) => ({
        item: s.item,
        analysisScreen: loadAnalysis(ctx, s.item.id)?.screen,
      })),
      threshold,
    );

    ctx.services.store.replaceDuplicateGroups(
      clusters.flatMap((cluster) =>
        cluster.members.map((member) => ({
          groupId: cluster.groupId,
          feedbackId: member.feedbackId,
          similarity: member.similarity,
        })),
      ),
    );

    const duplicateGroups = clusters.filter((cluster) => cluster.members.length > 1);
    return jsonResult({
      totalItems: stored.length,
      groups: clusters.length,
      duplicateGroups: duplicateGroups.map((cluster) => ({
        groupId: cluster.groupId,
        size: cluster.members.length,
        members: cluster.members,
      })),
      note:
        duplicateGroups.length === 0
          ? 'No duplicates detected at this threshold.'
          : 'Group assignments stored — prioritize_feedback now weights frequency.',
    });
  },
});

export const prioritizeFeedbackTool = defineTool({
  name: 'prioritize_feedback',
  title: 'Prioritize feedback',
  description:
    'Ranks unprocessed feedback by severity (from stored analyses; crashes default high), duplicate frequency, ' +
    'and recency. Returns scored groups with reasons. Run group_duplicates and analyze_feedback first for best results.',
  inputSchema: z.object({
    appId: z.string().optional().describe('Restrict to one app'),
    kind: z.enum(['screenshot', 'crash', 'all']).default('all'),
    limit: z.number().int().positive().max(50).default(10).describe('Max groups to return'),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ appId, kind, limit }, ctx) => {
    const stored = ctx.services.store.listLocal({
      appId,
      kind: kind === 'all' ? undefined : kind,
      limit: 500,
    });
    if (stored.length === 0) {
      return errorResult('No feedback in the local cache yet — run list_feedback first.');
    }

    const groupByFeedback = new Map(
      ctx.services.store.getDuplicateGroups().map((m) => [m.feedbackId, m.groupId]),
    );

    const inputs: PrioritizeInput[] = stored.map((s) => ({
      item: s.item,
      processed: s.processed,
      severity: loadAnalysis(ctx, s.item.id)?.severity,
      groupId: groupByFeedback.get(s.item.id),
    }));

    const ranked = prioritize(inputs).slice(0, limit);
    return jsonResult({
      groups: ranked,
      note:
        ranked.length === 0
          ? 'Nothing unprocessed to prioritize.'
          : 'Highest score first. Use analyze_feedback / generate_todo / create_issue on the representative ids.',
    });
  },
});
