/**
 * Release-pipeline tools: builds, readiness, version preparation, review
 * submission, and release. Write tools report per-step outcomes so a re-run
 * resumes instead of duplicating work (each step checks current state first).
 * All write operations need an ASC API key with the App Manager role.
 */
import { z } from 'zod';
import { defineTool } from '../../core/registry/define.js';
import type { AppStoreVersionSummary } from '../../asc/types.js';
import { buildReadinessReport, gatherReadinessFacts } from '../../asc/readiness.js';
import { jsonResult, requireRelease, resolveAppId } from './shared.js';

export interface StepOutcome {
  step: string;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
}

export const listBuildsTool = defineTool({
  name: 'list_builds',
  title: 'List builds',
  description:
    'Lists uploaded builds for an app (newest first): id, version, processing state, expiry, and ' +
    'export-compliance status. Use the build id with distribute_build or prepare_app_store_version.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    limit: z.number().int().min(1).max(200).optional().describe('Max builds to return (default 20)'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ appId, limit }, ctx) => {
    const release = requireRelease(ctx);
    const builds = await release.listBuilds(resolveAppId(appId, ctx), { limit }, ctx.signal);
    if (builds.length === 0) {
      return jsonResult({
        builds: [],
        note: 'No builds found. Upload a build with Xcode, Transporter, or CI first.',
      });
    }
    return jsonResult({ builds });
  },
});

export const getReleaseStatusTool = defineTool({
  name: 'get_release_status',
  title: 'Get release status',
  description:
    'Post-submission tracking: recent App Store versions with their states, review submissions, ' +
    'and phased-release progress. Use after submit_for_review to watch review and rollout.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    platform: z.string().optional().describe('Filter versions by platform, e.g. "IOS"'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ appId, platform }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const [versions, reviewSubmissions] = await Promise.all([
      release.listVersions(resolved, { platform, limit: 5 }, ctx.signal),
      release.listReviewSubmissions(resolved, { limit: 5 }, ctx.signal),
    ]);
    const withPhased = await Promise.all(
      versions.map(async (version: AppStoreVersionSummary) => ({
        ...version,
        phasedRelease: await release.getPhasedRelease(version.id, ctx.signal),
      })),
    );
    return jsonResult({ versions: withPhased, reviewSubmissions });
  },
});

export const checkSubmissionReadinessTool = defineTool({
  name: 'check_submission_readiness',
  title: 'Check submission readiness',
  description:
    'Deterministic completeness gate for App Store submission: verifies an editable version exists ' +
    'with a processed build, export compliance, description, screenshots, privacy policy, review ' +
    'contact, and age rating. Returns {ready, checks[]}. submit_for_review runs this automatically.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    platform: z.string().optional().describe('Platform, e.g. "IOS" (default: all)'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ appId, platform }, ctx) => {
    const release = requireRelease(ctx);
    const facts = await gatherReadinessFacts(release, resolveAppId(appId, ctx), platform, ctx.signal);
    return jsonResult(buildReadinessReport(facts));
  },
});
