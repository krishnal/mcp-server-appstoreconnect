/**
 * AI analysis tools — the dual-mode pair.
 *
 * analyze_feedback: with ANTHROPIC_API_KEY the server analyzes autonomously
 * (Claude vision + structured outputs) and persists the result. Without it,
 * the tool returns the screenshots + context + instructions so the HOST model
 * does the vision analysis and persists it via save_analysis. Either way the
 * stored shape is identical (see analysis/schema.ts).
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { buildContextText, hostAnalysisPrompt, type AnalyzerImage } from '../../analysis/analyzer.js';
import { analysisSchema } from '../../analysis/schema.js';
import type { ContentBlock } from '../../core/protocol/types.js';
import { defineTool } from '../../core/registry/define.js';
import {
  ensureScreenshots,
  errorResult,
  imageBlocks,
  jsonResult,
  loadFeedback,
  notFoundMessage,
} from './shared.js';

export const analyzeFeedbackTool = defineTool({
  name: 'analyze_feedback',
  title: 'Analyze feedback',
  description:
    'Analyzes a feedback item (screenshots + comment + device context). ' +
    'If the server has ANTHROPIC_API_KEY configured it runs Claude vision itself and stores a structured analysis ' +
    '(screen, problem, component, severity, confidence, suggested fix). ' +
    'Otherwise it returns the screenshots and context for YOU to analyze — then persist your result with save_analysis.',
  inputSchema: z.object({
    feedbackId: z.string().describe('Feedback id'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ feedbackId }, ctx) => {
    const stored = await loadFeedback(ctx, feedbackId);
    if (!stored) return errorResult(notFoundMessage(feedbackId));
    const item = stored.item;

    // Gather evidence: screenshots on disk (downloading as needed) + crash log.
    const shots = item.kind === 'screenshot' ? await ensureScreenshots(ctx, stored) : [];
    const crashLog =
      item.kind === 'crash' && ctx.services.asc
        ? await ctx.services.asc.getCrashLogText(item.id, ctx.signal)
        : undefined;

    const analyzer = ctx.services.analyzer;
    if (analyzer.enabled) {
      const images: AnalyzerImage[] = [];
      for (const shot of shots) {
        images.push({
          data: (await readFile(shot.path)).toString('base64'),
          mediaType: shot.mediaType,
        });
      }
      const analysis = await analyzer.analyze(item, images, crashLog, ctx.signal);
      ctx.services.store.saveAnalysis(item.id, analysis, 'api', analyzer.model);
      return jsonResult({
        feedbackId: item.id,
        source: 'api',
        model: analyzer.model,
        analysis,
        next: 'Analysis stored. Consider generate_todo or create_issue next.',
      });
    }

    // Host-delegated mode: hand the evidence to the calling model.
    const content: ContentBlock[] = [
      { type: 'text', text: buildContextText(item, crashLog) },
      ...(await imageBlocks(shots)),
      { type: 'text', text: hostAnalysisPrompt(item.id) },
    ];
    return { content };
  },
});

export const saveAnalysisTool = defineTool({
  name: 'save_analysis',
  title: 'Save analysis',
  description:
    'Persists a structured analysis for a feedback item (used by prioritize_feedback, generate_todo and create_issue). ' +
    'Call this after analyzing feedback yourself — analyze_feedback tells you when.',
  inputSchema: z.object({
    feedbackId: z.string().describe('Feedback id the analysis belongs to'),
    analysis: analysisSchema,
  }),
  annotations: { idempotentHint: true },
  handler: async ({ feedbackId, analysis }, ctx) => {
    const stored = await loadFeedback(ctx, feedbackId);
    if (!stored) return errorResult(notFoundMessage(feedbackId));
    ctx.services.store.saveAnalysis(feedbackId, analysis, 'host');
    return jsonResult({
      feedbackId,
      saved: true,
      next: 'Consider generate_todo to turn this into an actionable checklist.',
    });
  },
});
