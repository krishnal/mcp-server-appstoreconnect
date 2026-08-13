/**
 * Protocol-level tests of the release tools, driven through the real
 * dispatcher with a fake release client injected via the composition root.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/core/container.js';
import type { CallToolResult } from '../../src/core/protocol/types.js';
import { createTestApp, McpTestClient } from '../helpers/mcp-test-client.js';
import { createTestServices, emptyFakeRelease, fakeReleaseClient, type FakeRelease } from '../helpers/fixtures.js';

const apps: AppContext[] = [];
afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

export interface ReleaseSetup {
  client: McpTestClient;
  fake: FakeRelease;
}

export async function setupRelease(fake: FakeRelease): Promise<ReleaseSetup> {
  const services = createTestServices({ release: fakeReleaseClient(fake) });
  const context = createTestApp({ ASC_APP_ID: 'app-1' }, { services });
  apps.push(context);
  const client = new McpTestClient(context);
  await client.initialize();
  return { client, fake };
}

export function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('no text content');
  return block.text;
}

export function json(result: CallToolResult): any {
  return JSON.parse(firstText(result));
}

export async function call(
  client: McpTestClient,
  name: string,
  args: unknown = {},
): Promise<CallToolResult> {
  return client.request<CallToolResult>('tools/call', { name, arguments: args });
}

describe('list_builds', () => {
  it('returns build summaries', async () => {
    const { client } = await setupRelease(
      emptyFakeRelease({
        builds: [
          { id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: null },
        ],
      }),
    );
    const result = json(await call(client, 'list_builds'));
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0]).toMatchObject({ id: 'build-2', version: '422', processingState: 'VALID' });
  });

  it('explains missing ASC configuration', async () => {
    const services = createTestServices({});
    const context = createTestApp({ ASC_APP_ID: 'app-1' }, { services });
    apps.push(context);
    const client = new McpTestClient(context);
    await client.initialize();
    const result = await call(client, 'list_builds');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/ASC_ISSUER_ID/);
  });
});

describe('get_release_status', () => {
  it('reports versions, review submissions, and phased release progress', async () => {
    const { client } = await setupRelease(
      emptyFakeRelease({
        versions: [
          { id: 'v-1', versionString: '2.4.0', state: 'PENDING_DEVELOPER_RELEASE', releaseType: 'MANUAL' },
          { id: 'v-0', versionString: '2.3.0', state: 'READY_FOR_SALE' },
        ],
        reviewSubmissions: [{ id: 'rs-1', state: 'COMPLETE', platform: 'IOS' }],
        phasedReleases: new Map([['v-1', { id: 'pr-1', phasedReleaseState: 'ACTIVE', currentDayNumber: 3 }]]),
      }),
    );
    const result = json(await call(client, 'get_release_status'));
    expect(result.versions[0]).toMatchObject({ versionString: '2.4.0', state: 'PENDING_DEVELOPER_RELEASE' });
    expect(result.reviewSubmissions[0]).toMatchObject({ state: 'COMPLETE' });
    expect(result.versions[0].phasedRelease).toMatchObject({ phasedReleaseState: 'ACTIVE', currentDayNumber: 3 });
  });
});

describe('check_submission_readiness', () => {
  it('reports failing checks for an empty app', async () => {
    const { client } = await setupRelease(emptyFakeRelease());
    const result = json(await call(client, 'check_submission_readiness'));
    expect(result.ready).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: 'version-exists', status: 'fail' });
  });

  it('passes for a fully prepared version', async () => {
    const { client } = await setupRelease(
      emptyFakeRelease({
        versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION', buildId: 'build-2', buildVersion: '422' }],
        builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
        localizations: new Map([
          ['v-1', [{ id: 'loc-1', locale: 'en-US', description: 'A great app.', whatsNew: 'Fixes.' }]],
        ]),
        screenshotSets: new Map([['loc-1', [{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 3 }]]]),
        reviewDetails: new Map([['v-1', { id: 'rd-1', contactEmail: 'dev@example.com' }]]),
        appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/p', ageRating: { declared: true } },
      }),
    );
    const result = json(await call(client, 'check_submission_readiness'));
    expect(result.ready).toBe(true);
    expect(result.versionId).toBe('v-1');
  });
});

describe('prepare_app_store_version', () => {
  it('creates a version, attaches the build, sets whatsNew, and enables phased release', async () => {
    const fake = emptyFakeRelease({
      builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
    });
    const { client } = await setupRelease(fake);
    const result = json(
      await call(client, 'prepare_app_store_version', {
        versionString: '2.4.0',
        buildId: 'build-2',
        whatsNew: 'Bug fixes.',
        releaseType: 'AFTER_APPROVAL',
        phased: true,
      }),
    );
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'version', status: 'done' }),
      expect.objectContaining({ step: 'attach-build', status: 'done' }),
      expect.objectContaining({ step: 'whats-new', status: 'failed' }), // no localization exists in this fake
      expect.objectContaining({ step: 'phased-release', status: 'done' }),
    ]);
    expect(fake.calls).toContain('createVersion:2.4.0:AFTER_APPROVAL');
    expect(fake.calls).toContain('setVersionBuild:v-new-1:build-2');
  });

  it('is idempotent: re-running updates the existing version in place', async () => {
    const fake = emptyFakeRelease({
      versions: [
        { id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION', releaseType: 'AFTER_APPROVAL', buildId: 'build-2' },
      ],
      builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
      localizations: new Map([['v-1', [{ id: 'loc-1', locale: 'en-US' }]]]),
    });
    const { client } = await setupRelease(fake);
    const result = json(
      await call(client, 'prepare_app_store_version', {
        versionString: '2.4.0',
        buildId: 'build-2',
        whatsNew: 'Bug fixes.',
        releaseType: 'MANUAL',
      }),
    );
    expect(result.versionId).toBe('v-1');
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'version', status: 'done', detail: expect.stringMatching(/releaseType/) }),
      expect.objectContaining({ step: 'attach-build', status: 'skipped' }),
      expect.objectContaining({ step: 'whats-new', status: 'done' }),
      expect.objectContaining({ step: 'phased-release', status: 'skipped' }),
    ]);
    expect(fake.calls).toContain('updateVersion:v-1:MANUAL');
    expect(fake.calls).toContain('updateLocalization:loc-1:Bug fixes.');
    expect(fake.calls).not.toContain('createVersion:2.4.0:MANUAL');
  });

  it('refuses to reuse a version that exists in a non-editable state', async () => {
    const fake = emptyFakeRelease({
      versions: [{ id: 'v-1', versionString: '2.4.0', state: 'READY_FOR_SALE' }],
    });
    const { client } = await setupRelease(fake);
    const result = await call(client, 'prepare_app_store_version', { versionString: '2.4.0' });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/READY_FOR_SALE/);
  });
});

describe('distribute_build', () => {
  function distributableFake(): FakeRelease {
    return emptyFakeRelease({
      builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: null }],
      betaGroups: [
        { id: 'g-int', name: 'Team', isInternalGroup: true },
        { id: 'g-ext', name: 'External Testers', isInternalGroup: false },
      ],
      betaDetails: new Map([['build-2', { id: 'bd-1', externalBuildState: 'READY_FOR_BETA_SUBMISSION' }]]),
    });
  }

  it('sets compliance, submits beta review, and assigns groups', async () => {
    const fake = distributableFake();
    const { client } = await setupRelease(fake);
    const result = json(
      await call(client, 'distribute_build', {
        buildId: 'build-2',
        groups: ['External Testers'],
        usesNonExemptEncryption: false,
      }),
    );
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'export-compliance', status: 'done' }),
      expect.objectContaining({ step: 'beta-review', status: 'done' }),
      expect.objectContaining({ step: 'assign-groups', status: 'done' }),
    ]);
    expect(fake.calls).toContain('setExportCompliance:build-2:false');
    expect(fake.calls).toContain('submitForBetaReview:build-2');
    expect(fake.calls).toContain('addBuildToBetaGroups:build-2:g-ext');
  });

  it('fails the compliance step when unanswered and no parameter given', async () => {
    const fake = distributableFake();
    const { client } = await setupRelease(fake);
    const result = await call(client, 'distribute_build', { buildId: 'build-2', groups: ['Team'] });
    expect(result.isError).toBe(true);
    const parsed = json(result);
    expect(parsed.steps[0]).toMatchObject({ step: 'export-compliance', status: 'failed' });
    expect(parsed.steps[0].detail).toMatch(/usesNonExemptEncryption/);
  });

  it('skips completed steps on re-run (idempotent resume)', async () => {
    const fake = distributableFake();
    fake.builds[0]!.usesNonExemptEncryption = false;
    fake.betaDetails.set('build-2', { id: 'bd-1', externalBuildState: 'IN_BETA_REVIEW' });
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'distribute_build', { buildId: 'build-2', groups: ['External Testers'] }));
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'export-compliance', status: 'skipped' }),
      expect.objectContaining({ step: 'beta-review', status: 'skipped' }),
      expect.objectContaining({ step: 'assign-groups', status: 'done' }),
    ]);
  });

  it('fails group resolution with the available names', async () => {
    const fake = distributableFake();
    fake.builds[0]!.usesNonExemptEncryption = false;
    const { client } = await setupRelease(fake);
    const result = await call(client, 'distribute_build', { buildId: 'build-2', groups: ['Nope'] });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/External Testers/);
  });

  it('skips beta review when only internal groups are targeted', async () => {
    const fake = distributableFake();
    fake.builds[0]!.usesNonExemptEncryption = false;
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'distribute_build', { buildId: 'build-2', groups: ['Team'] }));
    expect(result.steps[1]).toMatchObject({ step: 'beta-review', status: 'skipped' });
    expect(fake.calls).not.toContain('submitForBetaReview:build-2');
  });
});

function readyFake(): FakeRelease {
  return emptyFakeRelease({
    versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION', buildId: 'build-2', buildVersion: '422' }],
    builds: [{ id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false }],
    localizations: new Map([['v-1', [{ id: 'loc-1', locale: 'en-US', description: 'A great app.', whatsNew: 'Fixes.' }]]]),
    screenshotSets: new Map([['loc-1', [{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 3 }]]]),
    reviewDetails: new Map([['v-1', { id: 'rd-1', contactEmail: 'dev@example.com' }]]),
    appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/p', ageRating: { declared: true } },
  });
}

describe('submit_for_review', () => {
  it('refuses with the failing checks when not ready', async () => {
    const { client } = await setupRelease(emptyFakeRelease());
    const result = await call(client, 'submit_for_review', {});
    expect(result.isError).toBe(true);
    const parsed = json(result);
    expect(parsed.submitted).toBe(false);
    expect(parsed.report.checks.some((c: { status: string }) => c.status === 'fail')).toBe(true);
  });

  it('submits when ready: create submission, add item, submit', async () => {
    const fake = readyFake();
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'submit_for_review', {}));
    expect(result.submitted).toBe(true);
    expect(result.reviewSubmissionId).toBe('rs-1');
    expect(fake.calls).toContain('createReviewSubmission:IOS');
    expect(fake.calls).toContain('addReviewSubmissionItem:rs-1:v-1');
    expect(fake.calls).toContain('submitReviewSubmission:rs-1');
  });

  it('force bypasses a failing readiness report', async () => {
    const fake = readyFake();
    fake.appInfo = { appInfoId: 'info-1', ageRating: { declared: false } }; // privacy + age rating now fail
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'submit_for_review', { force: true }));
    expect(result.submitted).toBe(true);
  });

  it('points at get_release_status when a submission is already in flight', async () => {
    const fake = readyFake();
    fake.reviewSubmissions = [{ id: 'rs-0', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }];
    const { client } = await setupRelease(fake);
    const result = await call(client, 'submit_for_review', {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/get_release_status/);
  });

  it('reuses an existing unsubmitted submission instead of creating another', async () => {
    const fake = readyFake();
    fake.reviewSubmissions = [{ id: 'rs-0', state: 'READY_FOR_REVIEW', platform: 'IOS' }];
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'submit_for_review', {}));
    expect(result.reviewSubmissionId).toBe('rs-0');
    expect(fake.calls).not.toContain('createReviewSubmission:IOS');
    expect(fake.calls).toContain('submitReviewSubmission:rs-0');
  });
});

describe('release_version', () => {
  it('releases a version pending developer release', async () => {
    const fake = emptyFakeRelease({
      versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PENDING_DEVELOPER_RELEASE' }],
    });
    const { client } = await setupRelease(fake);
    const result = json(await call(client, 'release_version', {}));
    expect(result.released).toMatchObject({ versionId: 'v-1', versionString: '2.4.0' });
    expect(fake.calls).toContain('createReleaseRequest:v-1');
  });

  it('errors when nothing is pending release', async () => {
    const { client } = await setupRelease(emptyFakeRelease());
    const result = await call(client, 'release_version', {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/PENDING_DEVELOPER_RELEASE/);
  });
});
