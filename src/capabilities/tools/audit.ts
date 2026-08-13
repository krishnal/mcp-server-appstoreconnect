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
import { parseRejection } from '../../audit/rejection-parser.js';
import type { GuidelineRule } from '../../audit/types.js';
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
