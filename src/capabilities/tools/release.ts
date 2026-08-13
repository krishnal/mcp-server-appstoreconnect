/**
 * Release-pipeline tools: builds, readiness, version preparation, review
 * submission, and release. Write tools report per-step outcomes so a re-run
 * resumes instead of duplicating work (each step checks current state first).
 * All write operations need an ASC API key with the App Manager role.
 */
import { z } from 'zod';
import { defineTool } from '../../core/registry/define.js';
import type { AppStoreVersionSummary } from '../../asc/types.js';
import { AscApiError } from '../../asc/types.js';
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

/** External beta states that mean review is already submitted or done. */
const BETA_REVIEW_DONE_STATES = [
  'WAITING_FOR_BETA_REVIEW',
  'IN_BETA_REVIEW',
  'BETA_APPROVED',
  'READY_FOR_BETA_TESTING',
  'IN_BETA_TESTING',
];

export const distributeBuildTool = defineTool({
  name: 'distribute_build',
  title: 'Distribute build to TestFlight groups',
  description:
    'Takes an already-uploaded build to testers: declares export compliance (if needed), submits ' +
    'for external beta review (if an external group is targeted), and assigns the build to beta ' +
    'groups. Idempotent — completed steps are skipped on re-run. Reports per-step outcomes.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    buildId: z.string().describe('Build to distribute (from list_builds)'),
    groups: z.array(z.string()).min(1).describe('Beta group names to assign the build to'),
    usesNonExemptEncryption: z
      .boolean()
      .optional()
      .describe('Encryption declaration; required if the build has none yet (false = only exempt encryption)'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  handler: async ({ appId, buildId, groups, usesNonExemptEncryption }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const steps: StepOutcome[] = [];

    const build = await release.getBuild(buildId, ctx.signal);
    if (!build) throw new Error(`Build "${buildId}" not found. Use list_builds to see available builds.`);

    // Step: export-compliance.
    if (build.usesNonExemptEncryption !== null && build.usesNonExemptEncryption !== undefined) {
      steps.push({ step: 'export-compliance', status: 'skipped', detail: 'Already declared.' });
    } else if (usesNonExemptEncryption === undefined) {
      steps.push({
        step: 'export-compliance',
        status: 'failed',
        detail:
          'Build has no encryption declaration. Pass usesNonExemptEncryption (false when the app ' +
          'only uses exempt encryption like HTTPS).',
      });
    } else {
      await release.setExportCompliance(buildId, usesNonExemptEncryption, ctx.signal);
      steps.push({ step: 'export-compliance', status: 'done', detail: `Declared usesNonExemptEncryption=${String(usesNonExemptEncryption)}.` });
    }

    // Resolve group names → ids before the remaining steps.
    const available = await release.listBetaGroups(resolved, ctx.signal);
    const wanted = groups.map((name) => ({
      name,
      group: available.find((g) => g.name === name),
    }));
    const missing = wanted.filter((w) => !w.group).map((w) => w.name);
    if (missing.length > 0) {
      throw new Error(
        `Unknown beta group(s): ${missing.join(', ')}. Available: ${available.map((g) => g.name).filter(Boolean).join(', ') || '(none)'}.`,
      );
    }
    const resolvedGroups = wanted.map((w) => w.group!);
    const needsExternal = resolvedGroups.some((g) => g.isInternalGroup === false);

    // Step: beta-review (only external groups need it).
    if (!needsExternal) {
      steps.push({ step: 'beta-review', status: 'skipped', detail: 'Only internal groups targeted.' });
    } else {
      const detail = await release.getBuildBetaDetail(buildId, ctx.signal);
      const state = detail?.externalBuildState;
      if (state && BETA_REVIEW_DONE_STATES.includes(state)) {
        steps.push({ step: 'beta-review', status: 'skipped', detail: `External state is ${state}.` });
      } else if (steps.some((s) => s.step === 'export-compliance' && s.status === 'failed')) {
        steps.push({ step: 'beta-review', status: 'failed', detail: 'Blocked on export compliance.' });
      } else {
        await release.submitForBetaReview(buildId, ctx.signal);
        steps.push({ step: 'beta-review', status: 'done', detail: 'Submitted for beta review.' });
      }
    }

    // Step: assign-groups.
    await release.addBuildToBetaGroups(buildId, resolvedGroups.map((g) => g.id), ctx.signal);
    steps.push({
      step: 'assign-groups',
      status: 'done',
      detail: `Assigned to: ${resolvedGroups.map((g) => g.name).join(', ')}.`,
    });

    const failed = steps.some((s) => s.status === 'failed');
    const result = jsonResult({ buildId, steps });
    return failed ? { ...result, isError: true } : result;
  },
});

/** Review-submission states that mean "already in Apple's queue". */
const SUBMISSION_IN_FLIGHT_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'];

export const submitForReviewTool = defineTool({
  name: 'submit_for_review',
  title: 'Submit for App Store review',
  description:
    'Submits the prepared App Store version to Apple review. Runs check_submission_readiness first ' +
    'and refuses (returning the failing checks) unless force:true. Reuses an existing unsubmitted ' +
    'review submission when present.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
    platform: z.string().optional().describe('Platform (default "IOS")'),
    force: z.boolean().optional().describe('Submit even if readiness checks fail (default false)'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async ({ appId, platform, force }, ctx) => {
    const release = requireRelease(ctx);
    const resolved = resolveAppId(appId, ctx);
    const targetPlatform = platform ?? 'IOS';

    const facts = await gatherReadinessFacts(release, resolved, targetPlatform, ctx.signal);
    const report = buildReadinessReport(facts);
    if (!report.ready && !force) {
      return {
        ...jsonResult({
          submitted: false,
          reason: 'Readiness checks are failing. Fix them (or pass force:true to submit anyway).',
          report,
        }),
        isError: true,
      };
    }
    if (!report.versionId) {
      throw new Error('No editable App Store version to submit. Create one with prepare_app_store_version.');
    }

    const existing = await release.listReviewSubmissions(resolved, { limit: 10 }, ctx.signal);
    const inFlight = existing.find((s) => s.state && SUBMISSION_IN_FLIGHT_STATES.includes(s.state));
    if (inFlight) {
      throw new Error(
        `A review submission is already ${inFlight.state}. Track it with get_release_status; ` +
          'cancel it in App Store Connect if you need to restart.',
      );
    }

    const steps: StepOutcome[] = [];
    let submission = existing.find((s) => s.state === 'READY_FOR_REVIEW');
    if (submission) {
      steps.push({ step: 'create-submission', status: 'skipped', detail: `Reusing ${submission.id}.` });
    } else {
      submission = await release.createReviewSubmission(resolved, targetPlatform, ctx.signal);
      steps.push({ step: 'create-submission', status: 'done', detail: submission.id });
    }

    try {
      await release.addReviewSubmissionItem(submission.id, report.versionId, ctx.signal);
      steps.push({ step: 'add-item', status: 'done', detail: `Version ${report.versionString ?? report.versionId}.` });
    } catch (err) {
      // Apple 409s when the version is already an item of this submission — that is resume, not failure.
      if (err instanceof AscApiError && err.status === 409) {
        steps.push({ step: 'add-item', status: 'skipped', detail: 'Version already in the submission.' });
      } else {
        throw err;
      }
    }

    const submitted = await release.submitReviewSubmission(submission.id, ctx.signal);
    steps.push({ step: 'submit', status: 'done', detail: `State: ${submitted.state ?? 'submitted'}.` });

    return jsonResult({
      submitted: true,
      reviewSubmissionId: submission.id,
      versionId: report.versionId,
      forced: Boolean(force && !report.ready),
      steps,
    });
  },
});

export const releaseVersionTool = defineTool({
  name: 'release_version',
  title: 'Release approved version',
  description:
    'Releases an approved, manually-held App Store version (state PENDING_DEVELOPER_RELEASE) to ' +
    'production. Only needed when the version was prepared with releaseType MANUAL.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App Store Connect app id (defaults to ASC_APP_ID)'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async ({ appId }, ctx) => {
    const release = requireRelease(ctx);
    const versions = await release.listVersions(resolveAppId(appId, ctx), { limit: 10 }, ctx.signal);
    const pending = versions.find((v) => v.state === 'PENDING_DEVELOPER_RELEASE');
    if (!pending) {
      throw new Error(
        'No version in state PENDING_DEVELOPER_RELEASE. Check get_release_status — the version may ' +
          'still be in review, or was prepared with releaseType AFTER_APPROVAL.',
      );
    }
    await release.createReleaseRequest(pending.id, ctx.signal);
    return jsonResult({ released: { versionId: pending.id, versionString: pending.versionString } });
  },
});
