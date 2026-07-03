/**
 * create_issue — files the feedback into GitHub / Jira / Linear with the full
 * context bundle (comment, device/build info, analysis, TODO, screenshot
 * paths). Idempotent: one issue per (feedback, provider), retries return the
 * existing link instead of filing duplicates.
 */
import { z } from 'zod';
import { buildIssueBody, buildIssueTitle } from '../../issues/index.js';
import { defineTool } from '../../core/registry/define.js';
import {
  errorResult,
  jsonResult,
  loadAnalysis,
  loadFeedback,
  notFoundMessage,
} from './shared.js';

export const createIssueTool = defineTool({
  name: 'create_issue',
  title: 'Create issue from feedback',
  description:
    'Creates an issue in GitHub, Jira, or Linear from a feedback item, including the tester comment, ' +
    'build/device context, stored AI analysis, TODO checklist, and screenshot paths. ' +
    'Idempotent per provider — returns the existing issue if one was already created.',
  inputSchema: z.object({
    provider: z.enum(['github', 'jira', 'linear']).describe('Issue tracker to file into'),
    feedbackId: z.string().describe('Feedback id'),
    title: z.string().optional().describe('Override the generated issue title'),
    labels: z.array(z.string()).optional().describe('Labels (GitHub/Jira; Linear ignores these in v1)'),
  }),
  annotations: { openWorldHint: true },
  handler: async ({ provider, feedbackId, title, labels }, ctx) => {
    const providerImpl = ctx.services.issueProviders.get(provider);
    if (!providerImpl) {
      const configured = [...ctx.services.issueProviders.keys()];
      return errorResult(
        `Issue provider "${provider}" is not configured.` +
          (configured.length > 0
            ? ` Configured providers: ${configured.join(', ')}.`
            : ' No providers configured — see README "Issue tracker integration".'),
      );
    }

    const existing = ctx.services.store.getIssue(feedbackId, provider);
    if (existing) {
      return jsonResult({
        provider,
        key: existing.issueKey,
        url: existing.issueUrl,
        created: false,
        note: 'Issue already exists for this feedback — returning the existing link.',
      });
    }

    const stored = await loadFeedback(ctx, feedbackId);
    if (!stored) return errorResult(notFoundMessage(feedbackId));

    const analysis = loadAnalysis(ctx, feedbackId);
    const input = {
      item: stored.item,
      analysis,
      todoMarkdown: ctx.services.store.getTodo(feedbackId),
      screenshotPaths: ctx.services.store.getScreenshots(feedbackId).map((s) => s.localPath),
    };

    const created = await providerImpl.create(
      {
        title: title ?? buildIssueTitle(input),
        bodyMarkdown: buildIssueBody(input),
        labels,
      },
      ctx.signal,
    );

    ctx.services.store.linkIssue({
      feedbackId,
      provider,
      issueKey: created.key,
      issueUrl: created.url,
    });

    return jsonResult({
      provider,
      key: created.key,
      url: created.url,
      created: true,
      next: `Consider mark_processed("${feedbackId}", note: "${created.key}").`,
    });
  },
});
