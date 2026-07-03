/**
 * Protocol-level tests of the TestFlight capabilities: driven through the
 * real dispatcher (exactly like a transport) with fake ASC upstream and
 * issue providers injected through the composition root.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/core/container.js';
import type { CallToolResult } from '../../src/core/protocol/types.js';
import { createTestApp, McpTestClient } from '../helpers/mcp-test-client.js';
import {
  createTestServices,
  fakeAscClient,
  fakeIssueProvider,
  feedbackItem,
  type FakeAsc,
} from '../helpers/fixtures.js';

const apps: AppContext[] = [];
afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

function newFakeAsc(): FakeAsc {
  return {
    items: [
      feedbackItem(),
      feedbackItem({
        id: 'fb-2',
        comment: 'Checkout button overlapping the total price',
        createdDate: '2026-07-02T10:00:00Z',
      }),
      feedbackItem({
        id: 'crash-1',
        kind: 'crash',
        comment: 'App crashed on launch',
        createdDate: '2026-07-03T08:00:00Z',
      }),
    ],
    apps: [{ id: 'app-1', name: 'My App', bundleId: 'com.example.app' }],
    crashLogs: new Map([['crash-1', 'Thread 0 crashed: EXC_BAD_ACCESS ...']]),
    calls: [],
  };
}

interface Setup {
  client: McpTestClient;
  context: AppContext;
  fake: FakeAsc;
}

async function setup(options: { withAsc?: boolean; providers?: boolean } = {}): Promise<Setup> {
  const fake = newFakeAsc();
  const services = createTestServices({
    asc: options.withAsc === false ? undefined : fakeAscClient(fake),
    providers: options.providers ? [fakeIssueProvider('github')] : [],
  });
  const context = createTestApp({ ASC_APP_ID: 'app-1' }, { services });
  apps.push(context);
  const client = new McpTestClient(context);
  await client.initialize();
  return { client, context, fake };
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

describe('tool registration', () => {
  it('exposes the full TestFlight tool surface', async () => {
    const { client } = await setup();
    const { tools } = await client.request<{ tools: { name: string }[] }>('tools/list');
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_apps',
        'list_feedback',
        'get_feedback',
        'get_crash_log',
        'download_screenshot',
        'list_unprocessed',
        'mark_processed',
        'mark_unprocessed',
        'analyze_feedback',
        'save_analysis',
        'generate_todo',
        'group_duplicates',
        'prioritize_feedback',
        'create_issue',
      ]),
    );
  });
});

describe('feedback tools', () => {
  it('list_feedback refreshes from ASC and returns summaries', async () => {
    const { client, fake } = await setup();
    const result = json(await call(client, 'list_feedback'));
    expect(result.count).toBe(3);
    expect(fake.calls).toContain('listFeedback:screenshot');
    expect(fake.calls).toContain('listFeedback:crash');
    const first = result.items[0];
    expect(first).toMatchObject({ id: 'crash-1', kind: 'crash', processed: false });
  });

  it('list_feedback works without ASC credentials (local cache only)', async () => {
    const { client } = await setup({ withAsc: false });
    const result = json(await call(client, 'list_feedback'));
    expect(result.count).toBe(0);
    expect(result.note).toMatch(/not configured/);
  });

  it('get_feedback returns full detail including local state', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');
    const detail = json(await call(client, 'get_feedback', { id: 'fb-1' }));
    expect(detail).toMatchObject({
      id: 'fb-1',
      kind: 'screenshot',
      buildNumber: '421',
      processed: false,
    });
    expect(detail.device.model).toBe('iPhone17,2');
  });

  it('mark_processed / list_unprocessed / mark_unprocessed round-trip', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');

    const marked = json(await call(client, 'mark_processed', { id: 'fb-1', note: 'fixed in 422' }));
    expect(marked).toMatchObject({ id: 'fb-1', processed: true, note: 'fixed in 422' });

    const queue = json(await call(client, 'list_unprocessed'));
    expect(queue.items.map((i: { id: string }) => i.id)).not.toContain('fb-1');

    const restored = json(await call(client, 'mark_unprocessed', { id: 'fb-1' }));
    expect(restored.processed).toBe(false);
  });

  it('unknown feedback ids produce actionable isError results', async () => {
    const { client } = await setup();
    const result = await call(client, 'get_feedback', { id: 'nope' });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/list_feedback/);
  });

  it('get_crash_log returns the crash log text', async () => {
    const { client } = await setup();
    const result = await call(client, 'get_crash_log', { id: 'crash-1' });
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toMatch(/EXC_BAD_ACCESS/);
  });

  it('ASC-backed tools explain missing configuration', async () => {
    const { client } = await setup({ withAsc: false });
    const result = await call(client, 'list_apps');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/ASC_ISSUER_ID/);
  });
});

describe('analysis tools', () => {
  it('analyze_feedback without an API key delegates to the host', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');
    const result = await call(client, 'analyze_feedback', { feedbackId: 'fb-1' });
    expect(result.isError).toBeUndefined();
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(text).toMatch(/save_analysis/);
    expect(text).toMatch(/iPhone17,2/);
  });

  it('save_analysis persists and get_feedback surfaces it', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');
    const saved = json(
      await call(client, 'save_analysis', {
        feedbackId: 'fb-1',
        analysis: {
          summary: 'Checkout button overlaps total',
          problem: 'Button frame overlaps the price label on small screens',
          screen: 'Checkout',
          suspectedComponent: 'CheckoutFooterView',
          severity: 'high',
          confidence: 0.9,
          suggestedFix: 'Constrain the button below the label',
        },
      }),
    );
    expect(saved.saved).toBe(true);

    const detail = json(await call(client, 'get_feedback', { id: 'fb-1' }));
    expect(detail.analysis.severity).toBe('high');
  });

  it('save_analysis rejects invalid payloads at the protocol layer', async () => {
    const { client } = await setup();
    const error = await client.requestExpectError('tools/call', {
      name: 'save_analysis',
      arguments: { feedbackId: 'fb-1', analysis: { severity: 'catastrophic' } },
    });
    expect(error.code).toBe(-32602);
  });

  it('generate_todo produces a checklist enriched by the stored analysis', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');
    await call(client, 'save_analysis', {
      feedbackId: 'fb-1',
      analysis: {
        summary: 'Checkout overlap',
        problem: 'Overlap',
        severity: 'high',
        confidence: 0.8,
        screen: 'Checkout',
      },
    });
    const result = await call(client, 'generate_todo', { feedbackId: 'fb-1' });
    const markdown = firstText(result);
    expect(markdown).toMatch(/- \[ \] Reproduce/);
    expect(markdown).toMatch(/Checkout/);
    expect(markdown).toMatch(/regression test/);
  });
});

describe('triage tools', () => {
  it('group_duplicates clusters similar comments and prioritize_feedback ranks them', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');

    const groups = json(await call(client, 'group_duplicates', {}));
    expect(groups.totalItems).toBe(3);
    expect(groups.duplicateGroups.length).toBe(1);
    expect(groups.duplicateGroups[0].size).toBe(2);

    const ranked = json(await call(client, 'prioritize_feedback', {}));
    expect(ranked.groups.length).toBeGreaterThan(0);
    // The crash (default severity high) should outrank the UI duplicates
    // unless the duplicates got an even higher stored severity.
    expect(ranked.groups[0].representative.id).toBe('crash-1');
    expect(ranked.groups[0].severity).toBe('high');
  });

  it('prioritize_feedback weights duplicate frequency', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');
    await call(client, 'save_analysis', {
      feedbackId: 'fb-1',
      analysis: { summary: 's', problem: 'p', severity: 'high', confidence: 0.9 },
    });
    await call(client, 'group_duplicates', {});
    const ranked = json(await call(client, 'prioritize_feedback', {}));
    const uiGroup = ranked.groups.find((g: { count: number }) => g.count === 2);
    expect(uiGroup).toBeDefined();
    expect(uiGroup.reasons).toContain('2 similar reports');
    // severity high + frequency beats severity high alone
    expect(ranked.groups[0].groupId).toBe(uiGroup.groupId);
  });
});

describe('create_issue', () => {
  it('is idempotent per provider and links the issue', async () => {
    const { client } = await setup({ providers: true });
    await call(client, 'list_feedback');

    const created = json(await call(client, 'create_issue', { provider: 'github', feedbackId: 'fb-1' }));
    expect(created).toMatchObject({ created: true, key: 'GITHUB-1' });

    const repeat = json(await call(client, 'create_issue', { provider: 'github', feedbackId: 'fb-1' }));
    expect(repeat).toMatchObject({ created: false, key: 'GITHUB-1' });

    const detail = json(await call(client, 'get_feedback', { id: 'fb-1' }));
    expect(detail.issues).toHaveLength(1);
  });

  it('names configured providers when asked for an unconfigured one', async () => {
    const { client } = await setup({ providers: true });
    await call(client, 'list_feedback');
    const result = await call(client, 'create_issue', { provider: 'jira', feedbackId: 'fb-1' });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/github/);
  });
});

describe('resources & prompts', () => {
  it('serves cached feedback at feedback://{id}', async () => {
    const { client } = await setup();
    await call(client, 'list_feedback');
    const read = await client.request<{ contents: { text: string }[] }>('resources/read', {
      uri: 'feedback://fb-1',
    });
    expect(JSON.parse(read.contents[0]!.text).id).toBe('fb-1');
  });

  it('returns resource-not-found for unknown feedback', async () => {
    const { client } = await setup();
    const error = await client.requestExpectError('resources/read', { uri: 'feedback://ghost' });
    expect(error.code).toBe(-32002);
  });

  it('exposes the triage prompt', async () => {
    const { client } = await setup();
    const prompt = await client.request<{ messages: { content: { text: string } }[] }>(
      'prompts/get',
      { name: 'triage_feedback', arguments: {} },
    );
    expect(prompt.messages[0]!.content.text).toMatch(/prioritize_feedback/);
  });
});
