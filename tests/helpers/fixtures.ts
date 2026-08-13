/**
 * Test fixtures: canned feedback items and a fake ASC client / issue provider
 * injectable through `CreateAppContextOptions.services`.
 */
import { FeedbackAnalyzer } from '../../src/analysis/analyzer.js';
import type { AscClient } from '../../src/asc/client.js';
import type { AscReleaseClient } from '../../src/asc/release-client.js';
import type {
  AppStoreVersionSummary,
  AppSummary,
  BetaGroupSummary,
  BuildBetaDetailSummary,
  BuildSummary,
  FeedbackItem,
  FeedbackKind,
  PhasedReleaseSummary,
  ReviewDetailSummary,
  ReviewSubmissionSummary,
  ScreenshotSetSummary,
  VersionLocalizationSummary,
} from '../../src/asc/types.js';
import type { Services } from '../../src/services/index.js';
import type { IssueProvider } from '../../src/issues/types.js';
import { createSilentLogger } from '../../src/observability/logger.js';
import { FeedbackStore } from '../../src/storage/feedback-store.js';

export function feedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 'fb-1',
    kind: 'screenshot',
    appId: 'app-1',
    createdDate: '2026-07-01T10:00:00Z',
    comment: 'The checkout button overlaps the total price label',
    buildNumber: '421',
    device: { model: 'iPhone17,2', osVersion: '26.1', platform: 'IOS' },
    screenshots: [],
    ...overrides,
  };
}

export interface FakeAsc {
  items: FeedbackItem[];
  apps: AppSummary[];
  crashLogs: Map<string, string>;
  calls: string[];
}

/** Structural stand-in for AscClient backed by canned data. */
export function fakeAscClient(fake: FakeAsc): AscClient {
  const client = {
    async listApps() {
      fake.calls.push('listApps');
      return fake.apps;
    },
    async listFeedback(kind: FeedbackKind, appId: string) {
      fake.calls.push(`listFeedback:${kind}`);
      return fake.items.filter((item) => item.kind === kind && item.appId === appId);
    },
    async getFeedback(kind: FeedbackKind, id: string) {
      fake.calls.push(`getFeedback:${kind}:${id}`);
      return fake.items.find((item) => item.kind === kind && item.id === id);
    },
    async getCrashLogText(id: string) {
      fake.calls.push(`getCrashLog:${id}`);
      return fake.crashLogs.get(id);
    },
    async downloadScreenshot(url: string, destPath: string) {
      fake.calls.push(`download:${url}`);
      return { path: destPath, bytes: 0 };
    },
  };
  return client as unknown as AscClient;
}

export function fakeIssueProvider(name: string): IssueProvider & { created: string[] } {
  const created: string[] = [];
  return {
    name,
    created,
    async create(payload) {
      created.push(payload.title);
      return { key: `${name.toUpperCase()}-1`, url: `https://example.com/${name}/1` };
    },
  };
}

export interface FakeRelease {
  builds: BuildSummary[];
  versions: AppStoreVersionSummary[];
  localizations: Map<string, VersionLocalizationSummary[]>;
  screenshotSets: Map<string, ScreenshotSetSummary[]>;
  reviewDetails: Map<string, ReviewDetailSummary>;
  appInfo?: { appInfoId: string; privacyPolicyUrl?: string; ageRating: { declared: boolean; inAppControls?: string | null } };
  subscriptions: boolean;
  customEula: boolean;
  betaGroups: BetaGroupSummary[];
  betaDetails: Map<string, BuildBetaDetailSummary>;
  reviewSubmissions: ReviewSubmissionSummary[];
  phasedReleases: Map<string, PhasedReleaseSummary>;
  calls: string[];
}

export function emptyFakeRelease(overrides: Partial<FakeRelease> = {}): FakeRelease {
  return {
    builds: [],
    versions: [],
    localizations: new Map(),
    screenshotSets: new Map(),
    reviewDetails: new Map(),
    appInfo: undefined,
    subscriptions: false,
    customEula: false,
    betaGroups: [],
    betaDetails: new Map(),
    reviewSubmissions: [],
    phasedReleases: new Map(),
    calls: [],
    ...overrides,
  };
}

/** Structural stand-in for AscReleaseClient. Writes mutate the canned data. */
export function fakeReleaseClient(fake: FakeRelease): AscReleaseClient {
  let idCounter = 0;
  const client = {
    async listBuilds() {
      fake.calls.push('listBuilds');
      return fake.builds;
    },
    async getBuild(buildId: string) {
      fake.calls.push(`getBuild:${buildId}`);
      return fake.builds.find((b) => b.id === buildId);
    },
    async listVersions() {
      fake.calls.push('listVersions');
      return fake.versions;
    },
    async getVersionLocalizations(versionId: string) {
      fake.calls.push(`getVersionLocalizations:${versionId}`);
      return fake.localizations.get(versionId) ?? [];
    },
    async listScreenshotSets(localizationId: string) {
      fake.calls.push(`listScreenshotSets:${localizationId}`);
      return fake.screenshotSets.get(localizationId) ?? [];
    },
    async getReviewDetail(versionId: string) {
      fake.calls.push(`getReviewDetail:${versionId}`);
      return fake.reviewDetails.get(versionId);
    },
    async getAppInfo() {
      fake.calls.push('getAppInfo');
      return fake.appInfo;
    },
    async hasSubscriptions() {
      fake.calls.push('hasSubscriptions');
      return fake.subscriptions;
    },
    async hasCustomEula() {
      fake.calls.push('hasCustomEula');
      return fake.customEula;
    },
    async listBetaGroups() {
      fake.calls.push('listBetaGroups');
      return fake.betaGroups;
    },
    async getBuildBetaDetail(buildId: string) {
      fake.calls.push(`getBuildBetaDetail:${buildId}`);
      return fake.betaDetails.get(buildId);
    },
    async listReviewSubmissions() {
      fake.calls.push('listReviewSubmissions');
      return fake.reviewSubmissions;
    },
    async getPhasedRelease(versionId: string) {
      fake.calls.push(`getPhasedRelease:${versionId}`);
      return fake.phasedReleases.get(versionId);
    },
    async createVersion(_appId: string, attrs: { versionString: string; platform: string; releaseType: string }) {
      fake.calls.push(`createVersion:${attrs.versionString}:${attrs.releaseType}`);
      const version = {
        id: `v-new-${(idCounter += 1)}`,
        versionString: attrs.versionString,
        state: 'PREPARE_FOR_SUBMISSION',
        releaseType: attrs.releaseType,
        platform: attrs.platform,
      };
      fake.versions.unshift(version);
      return version;
    },
    async updateVersion(versionId: string, attrs: { releaseType?: string }) {
      fake.calls.push(`updateVersion:${versionId}:${attrs.releaseType ?? ''}`);
      const version = fake.versions.find((v) => v.id === versionId);
      if (version && attrs.releaseType) version.releaseType = attrs.releaseType;
    },
    async setVersionBuild(versionId: string, buildId: string) {
      fake.calls.push(`setVersionBuild:${versionId}:${buildId}`);
      const version = fake.versions.find((v) => v.id === versionId);
      if (version) version.buildId = buildId;
    },
    async updateLocalization(localizationId: string, attrs: { whatsNew?: string }) {
      fake.calls.push(`updateLocalization:${localizationId}:${attrs.whatsNew ?? ''}`);
    },
    async createPhasedRelease(versionId: string) {
      fake.calls.push(`createPhasedRelease:${versionId}`);
      const phased = { id: `pr-${(idCounter += 1)}`, phasedReleaseState: 'INACTIVE' };
      fake.phasedReleases.set(versionId, phased);
      return phased;
    },
    async createReviewSubmission(_appId: string, platform: string) {
      fake.calls.push(`createReviewSubmission:${platform}`);
      const submission = { id: `rs-${(idCounter += 1)}`, state: 'READY_FOR_REVIEW', platform };
      fake.reviewSubmissions.unshift(submission);
      return submission;
    },
    async addReviewSubmissionItem(submissionId: string, versionId: string) {
      fake.calls.push(`addReviewSubmissionItem:${submissionId}:${versionId}`);
    },
    async submitReviewSubmission(submissionId: string) {
      fake.calls.push(`submitReviewSubmission:${submissionId}`);
      const submission = fake.reviewSubmissions.find((s) => s.id === submissionId);
      if (submission) submission.state = 'WAITING_FOR_REVIEW';
      return submission ?? { id: submissionId, state: 'WAITING_FOR_REVIEW' };
    },
    async createReleaseRequest(versionId: string) {
      fake.calls.push(`createReleaseRequest:${versionId}`);
    },
    async setExportCompliance(buildId: string, uses: boolean) {
      fake.calls.push(`setExportCompliance:${buildId}:${String(uses)}`);
      const build = fake.builds.find((b) => b.id === buildId);
      if (build) build.usesNonExemptEncryption = uses;
    },
    async submitForBetaReview(buildId: string) {
      fake.calls.push(`submitForBetaReview:${buildId}`);
    },
    async addBuildToBetaGroups(buildId: string, groupIds: string[]) {
      fake.calls.push(`addBuildToBetaGroups:${buildId}:${groupIds.join(',')}`);
    },
  };
  return client as unknown as AscReleaseClient;
}

export interface TestServicesOptions {
  asc?: AscClient | undefined;
  release?: AscReleaseClient | undefined;
  providers?: IssueProvider[];
}

export function createTestServices(options: TestServicesOptions = {}): Services {
  const store = new FeedbackStore(':memory:');
  return {
    store,
    asc: options.asc,
    release: options.release,
    analyzer: new FeedbackAnalyzer({ model: 'claude-opus-4-8', logger: createSilentLogger() }),
    issueProviders: new Map((options.providers ?? []).map((p) => [p.name, p])),
    dispose: () => store.close(),
  };
}
