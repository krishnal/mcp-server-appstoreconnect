/**
 * Submission-readiness: the deterministic completeness gate.
 *
 * `gatherReadinessFacts` performs the (parallel) ASC reads; the pure
 * `buildReadinessReport` turns facts into a structured checklist the calling
 * LLM can act on. This gate is about *completeness* (is everything present),
 * not guideline compliance — that is src/audit/'s job.
 */
import type { AscReleaseClient } from './release-client.js';
import type {
  AppInfoSummary,
  AppStoreVersionSummary,
  BuildSummary,
  ReviewDetailSummary,
  ScreenshotSetSummary,
  VersionLocalizationSummary,
} from './types.js';

/** Version states from which metadata can be edited and a submission started. */
export const EDITABLE_STATES: readonly string[] = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
];

export interface ReadinessCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  versionId?: string;
  versionString?: string;
  state?: string;
  checks: ReadinessCheck[];
}

export interface ReadinessFacts {
  version?: AppStoreVersionSummary;
  build?: BuildSummary;
  localizations: VersionLocalizationSummary[];
  screenshotSets: Map<string, ScreenshotSetSummary[]>;
  reviewDetail?: ReviewDetailSummary;
  appInfo?: AppInfoSummary;
}

export async function gatherReadinessFacts(
  release: AscReleaseClient,
  appId: string,
  platform: string | undefined,
  signal?: AbortSignal,
): Promise<ReadinessFacts> {
  const versions = await release.listVersions(appId, { platform, limit: 10 }, signal);
  const version = versions.find((v) => v.state && EDITABLE_STATES.includes(v.state));
  if (!version) {
    return { version: undefined, localizations: [], screenshotSets: new Map() };
  }

  const [build, localizations, reviewDetail, appInfo] = await Promise.all([
    version.buildId ? release.getBuild(version.buildId, signal) : Promise.resolve(undefined),
    release.getVersionLocalizations(version.id, signal),
    release.getReviewDetail(version.id, signal),
    release.getAppInfo(appId, signal),
  ]);

  const screenshotSets = new Map<string, ScreenshotSetSummary[]>();
  await Promise.all(
    localizations.map(async (loc) => {
      screenshotSets.set(loc.id, await release.listScreenshotSets(loc.id, signal));
    }),
  );

  return { version, build, localizations, screenshotSets, reviewDetail, appInfo };
}

export function buildReadinessReport(facts: ReadinessFacts): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const { version, build } = facts;

  if (!version) {
    checks.push({
      name: 'version-exists',
      status: 'fail',
      detail:
        'No App Store version in an editable state. Create one with prepare_app_store_version.',
    });
    return { ready: false, checks };
  }
  checks.push({
    name: 'version-exists',
    status: 'pass',
    detail: `Version ${version.versionString ?? '?'} is ${version.state ?? 'unknown'}.`,
  });

  if (!version.buildId) {
    checks.push({
      name: 'build-attached',
      status: 'fail',
      detail: 'No build attached. Pick one with list_builds and attach it via prepare_app_store_version.',
    });
  } else {
    checks.push({ name: 'build-attached', status: 'pass', detail: `Build ${version.buildVersion ?? version.buildId} attached.` });
    if (!build || build.processingState !== 'VALID' || build.expired) {
      checks.push({
        name: 'build-processed',
        status: 'fail',
        detail: build
          ? `Build is ${build.expired ? 'expired' : (build.processingState ?? 'unknown')} — attach a valid build.`
          : 'Attached build no longer exists — attach a valid build.',
      });
    } else {
      checks.push({ name: 'build-processed', status: 'pass', detail: 'Build processed and valid.' });
    }
    if (build && (build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined)) {
      checks.push({
        name: 'export-compliance',
        status: 'fail',
        detail:
          'Export-compliance not declared for the build. Set it via distribute_build ' +
          '(usesNonExemptEncryption) or answer in App Store Connect.',
      });
    } else if (build) {
      checks.push({ name: 'export-compliance', status: 'pass', detail: 'Encryption declaration present.' });
    }
  }

  const hasDescription = facts.localizations.some((loc) => Boolean(loc.description?.trim()));
  checks.push(
    hasDescription
      ? { name: 'description', status: 'pass', detail: 'App description present.' }
      : { name: 'description', status: 'fail', detail: 'No localization has a description — add one in App Store Connect.' },
  );

  const hasWhatsNew = facts.localizations.some((loc) => Boolean(loc.whatsNew?.trim()));
  checks.push(
    hasWhatsNew
      ? { name: 'whats-new', status: 'pass', detail: "What's-new text present." }
      : {
          name: 'whats-new',
          status: 'warn',
          detail: "No what's-new text (required for updates; not for a first release). Set it via prepare_app_store_version.",
        },
  );

  const localesMissingShots = facts.localizations
    .filter((loc) => {
      const sets = facts.screenshotSets.get(loc.id) ?? [];
      return !sets.some((set) => set.screenshotCount > 0);
    })
    .map((loc) => loc.locale ?? loc.id);
  checks.push(
    localesMissingShots.length === 0
      ? { name: 'screenshots', status: 'pass', detail: 'Every localization has screenshots.' }
      : {
          name: 'screenshots',
          status: 'fail',
          detail: `No screenshots for: ${localesMissingShots.join(', ')}. Upload them in App Store Connect.`,
        },
  );

  checks.push(
    facts.appInfo?.privacyPolicyUrl
      ? { name: 'privacy-policy', status: 'pass', detail: 'Privacy policy URL set.' }
      : { name: 'privacy-policy', status: 'fail', detail: 'No privacy policy URL — set it on the App Information page.' },
  );

  checks.push(
    facts.reviewDetail?.contactEmail
      ? { name: 'review-contact', status: 'pass', detail: 'Review contact present.' }
      : { name: 'review-contact', status: 'fail', detail: 'App Review contact info missing — fill it in App Store Connect.' },
  );

  checks.push(
    facts.appInfo?.ageRating.declared
      ? { name: 'age-rating', status: 'pass', detail: 'Age rating declared.' }
      : { name: 'age-rating', status: 'fail', detail: 'Age rating not declared — complete it on the App Information page.' },
  );

  return {
    ready: !checks.some((c) => c.status === 'fail'),
    versionId: version.id,
    versionString: version.versionString,
    state: version.state,
    checks,
  };
}
