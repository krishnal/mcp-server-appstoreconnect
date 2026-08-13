/**
 * Protocol-level tests of the audit tools with a fake release client and the
 * on-disk fixture project.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/core/container.js';
import type { CallToolResult } from '../../src/core/protocol/types.js';
import { createTestApp, McpTestClient } from '../helpers/mcp-test-client.js';
import { createTestServices, emptyFakeRelease, fakeReleaseClient, type FakeRelease } from '../helpers/fixtures.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-project');

const apps: AppContext[] = [];
afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

async function setup(fake?: FakeRelease): Promise<McpTestClient> {
  const services = createTestServices(fake ? { release: fakeReleaseClient(fake) } : {});
  const context = createTestApp({ ASC_APP_ID: 'app-1' }, { services });
  apps.push(context);
  const client = new McpTestClient(context);
  await client.initialize();
  return client;
}

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('no text content');
  return block.text;
}

function json(result: CallToolResult): any {
  return JSON.parse(firstText(result));
}

async function call(client: McpTestClient, name: string, args: unknown = {}): Promise<CallToolResult> {
  return client.request<CallToolResult>('tools/call', { name, arguments: args });
}

function subscribedFake(): FakeRelease {
  return emptyFakeRelease({
    subscriptions: true,
    appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/p', ageRating: { declared: true, inAppControls: 'NONE' } },
    versions: [{ id: 'v-1', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION' }],
    localizations: new Map([['v-1', [{ id: 'loc-1', locale: 'en-US', description: 'A great app.' }]]]),
  });
}

describe('audit_app_review', () => {
  it('audits ASC metadata only, reporting project rules as skipped', async () => {
    const client = await setup(subscribedFake());
    const result = json(await call(client, 'audit_app_review'));
    expect(result.rulePack.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const byId = Object.fromEntries(result.findings.map((f: { ruleId: string }) => [f.ruleId, f]));
    expect(byId['payments.subscription-terms']).toMatchObject({ status: 'fail' });
    expect(result.skippedChecks.map((s: { ruleId: string }) => s.ruleId)).toContain('privacy.purpose-strings');
  });

  it('includes project-based findings when projectPath is given', async () => {
    const client = await setup(subscribedFake());
    const result = json(await call(client, 'audit_app_review', { projectPath: FIXTURE }));
    const purpose = result.findings.find((f: { ruleId: string }) => f.ruleId === 'privacy.purpose-strings');
    expect(purpose.status).toBe('fail'); // fixture has an empty NSPhotoLibraryUsageDescription
    expect(purpose.detail).toMatch(/NSPhotoLibraryUsageDescription/);
    const deletion = result.findings.find((f: { ruleId: string }) => f.ruleId === 'privacy.account-deletion');
    expect(deletion.status).toBe('needs_judgment');
    expect(result.skippedChecks).toEqual([]);
  });

  it('errors readably on a bad projectPath', async () => {
    const client = await setup(subscribedFake());
    const result = await call(client, 'audit_app_review', { projectPath: '/no/such/dir' });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/projectPath/);
  });

  it('explains missing ASC configuration', async () => {
    const client = await setup();
    const result = await call(client, 'audit_app_review');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/ASC_ISSUER_ID/);
  });
});
