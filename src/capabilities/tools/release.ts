/**
 * Release-pipeline tools: builds, readiness, version preparation, review
 * submission, and release. Write tools report per-step outcomes so a re-run
 * resumes instead of duplicating work (each step checks current state first).
 * All write operations need an ASC API key with the App Manager role.
 */
import { z } from 'zod';
import { defineTool } from '../../core/registry/define.js';
import type { AppStoreVersionSummary } from '../../asc/types.js';
import { buildReadinessReport, gatherReadinessFacts, EDITABLE_STATES } from '../../asc/readiness.js';
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

const releaseTypeSchema = z
  .enum(['AFTER_APPROVAL', 'MANUAL', 'SCHEDULED'])
  .describe('How the version goes live after approval (default AFTER_APPROVAL)');

export const prepareAppStoreVersionTool = defineTool({
  name: 'prepare_app_store_version',
  title: 'Prepare App Store version',
  description:
    'Creates or updates an App Store version, optionally attaches a build, sets what\'s-new text, ' +
    'and enables phased release. Idempotent: re-running updates in place and skips completed steps. ' +
    'Heavy metadata (description, screenshots, privacy) is managed in App Store Connect — ' +
    'check_submission_readiness reports what is missing there.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    versionString: z.string().describe('Marketing version, e.g. "2.4.0"'),
    buildId: z.string().optional().describe('Build to attach (from list_builds)'),
    whatsNew: z.string().optional().describe("What's-new release notes for the primary localization"),
    releaseType: releaseTypeSchema.optional(),
    phased: z.boolean().optional().describe('Enable 7-day phased release (default false)'),
    platform: z.string().optional().describe('Platform (default "IOS")'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  handler: async ({ appId, versionString, buildId, whatsNew, releaseType, phased, platform }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const wantedType = releaseType ?? 'AFTER_APPROVAL';
    const steps: StepOutcome[] = [];

    // Step: version (create or update in place).
    const versions = await release.listVersions(resolved, { platform, limit: 20 }, ctx.signal);
    let version = versions.find((v) => v.versionString === versionString);
    if (version && version.state && !EDITABLE_STATES.includes(version.state)) {
      throw new Error(
        `Version ${versionString} already exists in state ${version.state} and cannot be edited. ` +
          'Use a new versionString.',
      );
    }
    if (!version) {
      version = await release.createVersion(
        resolved,
        { versionString, platform: platform ?? 'IOS', releaseType: wantedType },
        ctx.signal,
      );
      steps.push({ step: 'version', status: 'done', detail: `Created version ${versionString}.` });
    } else if (version.releaseType !== wantedType) {
      await release.updateVersion(version.id, { releaseType: wantedType }, ctx.signal);
      steps.push({ step: 'version', status: 'done', detail: `Updated releaseType to ${wantedType}.` });
    } else {
      steps.push({ step: 'version', status: 'skipped', detail: 'Version already up to date.' });
    }

    // Step: attach-build.
    if (!buildId) {
      steps.push({ step: 'attach-build', status: 'skipped', detail: 'No buildId given.' });
    } else if (version.buildId === buildId) {
      steps.push({ step: 'attach-build', status: 'skipped', detail: 'Build already attached.' });
    } else {
      await release.setVersionBuild(version.id, buildId, ctx.signal);
      steps.push({ step: 'attach-build', status: 'done', detail: `Attached build ${buildId}.` });
    }

    // Step: whats-new (primary localization = first returned).
    if (!whatsNew) {
      steps.push({ step: 'whats-new', status: 'skipped', detail: 'No whatsNew given.' });
    } else {
      const localizations = await release.getVersionLocalizations(version.id, ctx.signal);
      const primary = localizations[0];
      if (!primary) {
        steps.push({
          step: 'whats-new',
          status: 'failed',
          detail: 'Version has no localizations yet — add one in App Store Connect, then re-run.',
        });
      } else {
        await release.updateLocalization(primary.id, { whatsNew }, ctx.signal);
        steps.push({ step: 'whats-new', status: 'done', detail: `Set what's-new for ${primary.locale ?? 'primary'}.` });
      }
    }

    // Step: phased-release.
    if (!phased) {
      steps.push({ step: 'phased-release', status: 'skipped', detail: 'Phased release not requested.' });
    } else {
      const existing = await release.getPhasedRelease(version.id, ctx.signal);
      if (existing) {
        steps.push({ step: 'phased-release', status: 'skipped', detail: 'Phased release already configured.' });
      } else {
        await release.createPhasedRelease(version.id, ctx.signal);
        steps.push({ step: 'phased-release', status: 'done', detail: 'Phased release enabled.' });
      }
    }

    const failed = steps.some((s) => s.status === 'failed');
    const result = jsonResult({ versionId: version.id, versionString, steps });
    return failed ? { ...result, isError: true } : result;
  },
});
