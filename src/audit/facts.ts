/**
 * AppFacts gathering: parallel ASC reads plus the optional local project
 * scan. Descriptions come from the newest editable App Store version (falling
 * back to the newest version of any state) so the audit sees the metadata
 * that would actually be submitted.
 */
import type { AscReleaseClient } from '../asc/release-client.js';
import { EDITABLE_STATES } from '../asc/readiness.js';
import { scanProject } from './project-scan.js';
import type { AppFacts } from './types.js';

export async function gatherAppFacts(
  release: AscReleaseClient,
  appId: string,
  options: { projectPath?: string; platform?: string; signal?: AbortSignal } = {},
): Promise<AppFacts> {
  const { projectPath, platform, signal } = options;
  const [hasSubscriptions, hasCustomEula, appInfo, versions, project] = await Promise.all([
    release.hasSubscriptions(appId, signal),
    release.hasCustomEula(appId, signal),
    release.getAppInfo(appId, signal),
    release.listVersions(appId, { platform, limit: 10 }, signal),
    projectPath ? scanProject(projectPath) : Promise.resolve(undefined),
  ]);

  const version =
    versions.find((v) => v.state && EDITABLE_STATES.includes(v.state)) ?? versions[0];
  const localizations = version
    ? await release.getVersionLocalizations(version.id, signal)
    : [];

  return {
    appId,
    hasSubscriptions,
    hasCustomEula,
    privacyPolicyUrl: appInfo?.privacyPolicyUrl,
    ageRating: appInfo?.ageRating ?? { declared: false },
    descriptions: localizations.map((loc) => ({ locale: loc.locale, text: loc.description })),
    project,
  };
}
