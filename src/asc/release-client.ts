/**
 * App Store Connect API client — release surface.
 *
 * Everything the release-pipeline tools need that is not TestFlight feedback:
 * builds, App Store versions & localizations, review submissions, phased
 * releases, beta groups, app info (privacy policy, age rating) and
 * IAP/subscription presence. Shares transport semantics with the feedback
 * client via {@link AscHttp}. Write methods live here too (added task by
 * task); every method takes an optional trailing AbortSignal.
 */
import { AscHttp } from './http.js';
import type { AscClientOptions } from './client.js';
import {
  AscApiError,
  type AgeRatingDeclarationAttributes,
  type AppInfoLocalizationAttributes,
  type AppInfoSummary,
  type AppScreenshotSetAttributes,
  type AppStoreVersionAttributes,
  type AppStoreVersionLocalizationAttributes,
  type AppStoreVersionSummary,
  type AscListResponse,
  type AscResource,
  type AscSingleResponse,
  type BetaGroupAttributes,
  type BetaGroupSummary,
  type BuildAttributes,
  type BuildBetaDetailAttributes,
  type BuildBetaDetailSummary,
  type BuildSummary,
  type PhasedReleaseAttributes,
  type PhasedReleaseSummary,
  type ReleaseType,
  type ReviewDetailAttributes,
  type ReviewDetailSummary,
  type ReviewSubmissionAttributes,
  type ReviewSubmissionSummary,
  type ScreenshotSetSummary,
  type VersionLocalizationSummary,
} from './types.js';

const MAX_PAGE_SIZE = 200;

export class AscReleaseClient {
  private readonly http: AscHttp;

  constructor(options: AscClientOptions) {
    this.http = new AscHttp(options);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listBuilds(
    appId: string,
    options: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<BuildSummary[]> {
    const query = new URLSearchParams({
      'filter[app]': appId,
      sort: '-uploadedDate',
      'fields[builds]': 'version,uploadedDate,expired,processingState,usesNonExemptEncryption',
      limit: String(Math.min(options.limit ?? 20, MAX_PAGE_SIZE)),
    });
    const body = await this.http.request<AscListResponse<BuildAttributes>>(
      'GET',
      `/v1/builds?${query.toString()}`,
      { signal },
    );
    return body.data.map(toBuildSummary);
  }

  async getBuild(buildId: string, signal?: AbortSignal): Promise<BuildSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<BuildAttributes>>(
        'GET',
        `/v1/builds/${encodeURIComponent(buildId)}`,
        { signal },
      );
      return toBuildSummary(body.data);
    });
  }

  async listVersions(
    appId: string,
    options: { platform?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<AppStoreVersionSummary[]> {
    const query = new URLSearchParams({
      include: 'build',
      'fields[builds]': 'version',
      limit: String(Math.min(options.limit ?? 20, 50)),
    });
    if (options.platform) query.set('filter[platform]', options.platform);
    const body = await this.http.request<AscListResponse<AppStoreVersionAttributes>>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?${query.toString()}`,
      { signal },
    );
    const buildVersions = new Map<string, string>();
    for (const resource of body.included ?? []) {
      if (resource.type === 'builds') {
        const version = (resource.attributes as BuildAttributes | undefined)?.version;
        if (version) buildVersions.set(resource.id, version);
      }
    }
    return body.data.map((resource) => {
      const attributes = resource.attributes ?? {};
      const buildRef = resource.relationships?.['build']?.data;
      const buildId = buildRef && !Array.isArray(buildRef) ? buildRef.id : undefined;
      return {
        id: resource.id,
        versionString: attributes.versionString,
        state: attributes.appVersionState ?? attributes.appStoreState,
        releaseType: attributes.releaseType,
        platform: attributes.platform,
        createdDate: attributes.createdDate,
        buildId,
        buildVersion: buildId ? buildVersions.get(buildId) : undefined,
      };
    });
  }

  async getVersionLocalizations(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<VersionLocalizationSummary[]> {
    const body = await this.http.request<AscListResponse<AppStoreVersionLocalizationAttributes>>(
      'GET',
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=50`,
      { signal },
    );
    return body.data.map((resource) => ({
      id: resource.id,
      locale: resource.attributes?.locale,
      description: resource.attributes?.description,
      whatsNew: resource.attributes?.whatsNew,
      supportUrl: resource.attributes?.supportUrl,
    }));
  }

  async listScreenshotSets(
    localizationId: string,
    signal?: AbortSignal,
  ): Promise<ScreenshotSetSummary[]> {
    const body = await this.http.request<AscListResponse<AppScreenshotSetAttributes>>(
      'GET',
      `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets?include=appScreenshots&limit=50`,
      { signal },
    );
    return body.data.map((resource) => {
      const refs = resource.relationships?.['appScreenshots']?.data;
      return {
        id: resource.id,
        displayType: resource.attributes?.screenshotDisplayType,
        screenshotCount: Array.isArray(refs) ? refs.length : 0,
      };
    });
  }

  async getReviewDetail(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<ReviewDetailSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<ReviewDetailAttributes>>(
        'GET',
        `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreReviewDetail`,
        { signal },
      );
      return { id: body.data.id, ...body.data.attributes };
    });
  }

  async getAppInfo(appId: string, signal?: AbortSignal): Promise<AppInfoSummary | undefined> {
    const infos = await this.http.request<AscListResponse<Record<string, unknown>>>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/appInfos?limit=2`,
      { signal },
    );
    const appInfo = infos.data[0];
    if (!appInfo) return undefined;

    const [localizations, ageRating] = await Promise.all([
      this.http.request<AscListResponse<AppInfoLocalizationAttributes>>(
        'GET',
        `/v1/appInfos/${encodeURIComponent(appInfo.id)}/appInfoLocalizations?limit=50`,
        { signal },
      ),
      this.optional(() =>
        this.http.request<AscSingleResponse<AgeRatingDeclarationAttributes>>(
          'GET',
          `/v1/appInfos/${encodeURIComponent(appInfo.id)}/ageRatingDeclaration`,
          { signal },
        ),
      ),
    ]);

    const privacyPolicyUrl = localizations.data
      .map((loc) => loc.attributes?.privacyPolicyUrl)
      .find(Boolean);
    return {
      appInfoId: appInfo.id,
      privacyPolicyUrl,
      ageRating: ageRating
        ? { declared: true, inAppControls: ageRating.data.attributes?.inAppControls }
        : { declared: false },
    };
  }

  async hasSubscriptions(appId: string, signal?: AbortSignal): Promise<boolean> {
    const body = await this.http.request<AscListResponse>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=1`,
      { signal },
    );
    return body.data.length > 0;
  }

  async hasCustomEula(appId: string, signal?: AbortSignal): Promise<boolean> {
    const eula = await this.optional(() =>
      this.http.request<AscSingleResponse>(
        'GET',
        `/v1/apps/${encodeURIComponent(appId)}/endUserLicenseAgreement`,
        { signal },
      ),
    );
    return eula !== undefined;
  }

  async listBetaGroups(appId: string, signal?: AbortSignal): Promise<BetaGroupSummary[]> {
    const body = await this.http.request<AscListResponse<BetaGroupAttributes>>(
      'GET',
      `/v1/apps/${encodeURIComponent(appId)}/betaGroups?fields[betaGroups]=name,isInternalGroup&limit=${MAX_PAGE_SIZE}`,
      { signal },
    );
    return body.data.map((resource) => ({
      id: resource.id,
      name: resource.attributes?.name,
      isInternalGroup: resource.attributes?.isInternalGroup,
    }));
  }

  async getBuildBetaDetail(
    buildId: string,
    signal?: AbortSignal,
  ): Promise<BuildBetaDetailSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<BuildBetaDetailAttributes>>(
        'GET',
        `/v1/builds/${encodeURIComponent(buildId)}/buildBetaDetail`,
        { signal },
      );
      return { id: body.data.id, ...body.data.attributes };
    });
  }

  async listReviewSubmissions(
    appId: string,
    options: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ReviewSubmissionSummary[]> {
    const query = new URLSearchParams({
      'filter[app]': appId,
      limit: String(Math.min(options.limit ?? 10, 50)),
    });
    const body = await this.http.request<AscListResponse<ReviewSubmissionAttributes>>(
      'GET',
      `/v1/reviewSubmissions?${query.toString()}`,
      { signal },
    );
    return body.data.map((resource) => ({ id: resource.id, ...resource.attributes }));
  }

  async getPhasedRelease(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<PhasedReleaseSummary | undefined> {
    return this.optional(async () => {
      const body = await this.http.request<AscSingleResponse<PhasedReleaseAttributes>>(
        'GET',
        `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionPhasedRelease`,
        { signal },
      );
      return { id: body.data.id, ...body.data.attributes };
    });
  }

  // -------------------------------------------------------------------------
  // Writes — require an API key with the App Manager role
  // -------------------------------------------------------------------------

  async createVersion(
    appId: string,
    attrs: { versionString: string; platform: string; releaseType: ReleaseType },
    signal?: AbortSignal,
  ): Promise<AppStoreVersionSummary> {
    const body = await this.http.request<AscSingleResponse<AppStoreVersionAttributes>>(
      'POST',
      '/v1/appStoreVersions',
      {
        body: {
          data: {
            type: 'appStoreVersions',
            attributes: attrs,
            relationships: { app: { data: { type: 'apps', id: appId } } },
          },
        },
        signal,
      },
    );
    const a = body.data.attributes ?? {};
    return {
      id: body.data.id,
      versionString: a.versionString,
      state: a.appVersionState ?? a.appStoreState,
      releaseType: a.releaseType,
      platform: a.platform,
    };
  }

  async updateVersion(
    versionId: string,
    attrs: { releaseType?: ReleaseType },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('PATCH', `/v1/appStoreVersions/${encodeURIComponent(versionId)}`, {
      body: { data: { type: 'appStoreVersions', id: versionId, attributes: attrs } },
      signal,
    });
  }

  async setVersionBuild(versionId: string, buildId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request(
      'PATCH',
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`,
      { body: { data: { type: 'builds', id: buildId } }, signal },
    );
  }

  async updateLocalization(
    localizationId: string,
    attrs: { whatsNew?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request(
      'PATCH',
      `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`,
      {
        body: { data: { type: 'appStoreVersionLocalizations', id: localizationId, attributes: attrs } },
        signal,
      },
    );
  }

  async createPhasedRelease(versionId: string, signal?: AbortSignal): Promise<PhasedReleaseSummary> {
    const body = await this.http.request<AscSingleResponse<PhasedReleaseAttributes>>(
      'POST',
      '/v1/appStoreVersionPhasedReleases',
      {
        body: {
          data: {
            type: 'appStoreVersionPhasedReleases',
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        },
        signal,
      },
    );
    return { id: body.data.id, ...body.data.attributes };
  }

  async createReviewSubmission(
    appId: string,
    platform: string,
    signal?: AbortSignal,
  ): Promise<ReviewSubmissionSummary> {
    const body = await this.http.request<AscSingleResponse<ReviewSubmissionAttributes>>(
      'POST',
      '/v1/reviewSubmissions',
      {
        body: {
          data: {
            type: 'reviewSubmissions',
            attributes: { platform },
            relationships: { app: { data: { type: 'apps', id: appId } } },
          },
        },
        signal,
      },
    );
    return { id: body.data.id, ...body.data.attributes };
  }

  async addReviewSubmissionItem(
    submissionId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('POST', '/v1/reviewSubmissionItems', {
      body: {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
          },
        },
      },
      signal,
    });
  }

  async submitReviewSubmission(
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ReviewSubmissionSummary> {
    const body = await this.http.request<AscSingleResponse<ReviewSubmissionAttributes>>(
      'PATCH',
      `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`,
      {
        body: { data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } },
        signal,
      },
    );
    return { id: body.data.id, ...body.data.attributes };
  }

  async createReleaseRequest(versionId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request('POST', '/v1/appStoreVersionReleaseRequests', {
      body: {
        data: {
          type: 'appStoreVersionReleaseRequests',
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
        },
      },
      signal,
    });
  }

  async setExportCompliance(
    buildId: string,
    usesNonExemptEncryption: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('PATCH', `/v1/builds/${encodeURIComponent(buildId)}`, {
      body: { data: { type: 'builds', id: buildId, attributes: { usesNonExemptEncryption } } },
      signal,
    });
  }

  async submitForBetaReview(buildId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request('POST', '/v1/betaAppReviewSubmissions', {
      body: {
        data: {
          type: 'betaAppReviewSubmissions',
          relationships: { build: { data: { type: 'builds', id: buildId } } },
        },
      },
      signal,
    });
  }

  async addBuildToBetaGroups(
    buildId: string,
    groupIds: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request('POST', `/v1/builds/${encodeURIComponent(buildId)}/relationships/betaGroups`, {
      body: { data: groupIds.map((id) => ({ type: 'betaGroups', id })) },
      signal,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Run a read, mapping 404 to undefined (resource legitimately absent). */
  private async optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AscApiError && err.status === 404) return undefined;
      throw err;
    }
  }
}

function toBuildSummary(resource: AscResource<BuildAttributes>): BuildSummary {
  const attributes = resource.attributes ?? {};
  return {
    id: resource.id,
    version: attributes.version,
    uploadedDate: attributes.uploadedDate,
    processingState: attributes.processingState,
    expired: attributes.expired,
    usesNonExemptEncryption: attributes.usesNonExemptEncryption,
  };
}
