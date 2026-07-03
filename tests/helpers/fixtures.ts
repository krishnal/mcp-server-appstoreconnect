/**
 * Test fixtures: canned feedback items and a fake ASC client / issue provider
 * injectable through `CreateAppContextOptions.services`.
 */
import { FeedbackAnalyzer } from '../../src/analysis/analyzer.js';
import type { AscClient } from '../../src/asc/client.js';
import type { AppSummary, FeedbackItem, FeedbackKind } from '../../src/asc/types.js';
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

export interface TestServicesOptions {
  asc?: AscClient | undefined;
  providers?: IssueProvider[];
}

export function createTestServices(options: TestServicesOptions = {}): Services {
  const store = new FeedbackStore(':memory:');
  return {
    store,
    asc: options.asc,
    analyzer: new FeedbackAnalyzer({ model: 'claude-opus-4-8', logger: createSilentLogger() }),
    issueProviders: new Map((options.providers ?? []).map((p) => [p.name, p])),
    dispose: () => store.close(),
  };
}
