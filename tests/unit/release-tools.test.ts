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
