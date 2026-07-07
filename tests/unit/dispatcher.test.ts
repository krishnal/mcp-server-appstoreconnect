import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppContext } from '../../src/core/container.js';
import { JsonRpcErrorCodes, McpErrorCodes } from '../../src/core/jsonrpc/errors.js';
import { LATEST_PROTOCOL_VERSION } from '../../src/core/protocol/versions.js';
import { defineTool } from '../../src/core/registry/define.js';
import { registerAllCapabilities } from '../../src/capabilities/index.js';
import { createTestApp, McpTestClient } from '../helpers/mcp-test-client.js';

const apps: AppContext[] = [];
function app(...args: Parameters<typeof createTestApp>): AppContext {
  const created = createTestApp(...args);
  apps.push(created);
  return created;
}
afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

describe('lifecycle', () => {
  it('answers ping before initialization', async () => {
    const client = new McpTestClient(app());
    expect(await client.request('ping')).toEqual({});
  });

  it('rejects other requests before initialization', async () => {
    const client = new McpTestClient(app());
    const error = await client.requestExpectError('tools/list');
    expect(error.code).toBe(McpErrorCodes.ServerNotInitialized);
  });

  it('negotiates a supported protocol version', async () => {
    const client = new McpTestClient(app());
    const result = (await client.initialize('2025-03-26')) as { protocolVersion: string };
    expect(result.protocolVersion).toBe('2025-03-26');
  });

  it('falls back to the latest version for unknown revisions', async () => {
    const client = new McpTestClient(app());
    const result = (await client.initialize('1999-01-01')) as {
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: Record<string, unknown>;
    };
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe('mcp-server-appstoreconnect');
    expect(result.capabilities['tools']).toEqual({ listChanged: true });
  });

  it('rejects a second initialize on the same session', async () => {
    const client = new McpTestClient(app());
    await client.initialize();
    const error = await client.requestExpectError('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'x', version: '1' },
    });
    expect(error.code).toBe(JsonRpcErrorCodes.InvalidRequest);
  });
});

describe('dispatch errors', () => {
  it('returns -32601 for unknown methods', async () => {
    const client = new McpTestClient(app());
    await client.initialize();
    const error = await client.requestExpectError('does/not/exist');
    expect(error.code).toBe(JsonRpcErrorCodes.MethodNotFound);
  });

  it('returns -32602 with issue details for invalid params', async () => {
    const client = new McpTestClient(app());
    await client.initialize();
    const error = await client.requestExpectError('tools/call', { arguments: {} });
    expect(error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(error.data).toMatchObject({ issues: [{ path: 'name' }] });
  });

  it('rejects structurally invalid messages without throwing', async () => {
    const context = app();
    const client = new McpTestClient(context);
    const response = await context.dispatcher.handleMessage(
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      client.session,
    );
    expect(response && 'error' in response && response.error.code).toBe(
      JsonRpcErrorCodes.InvalidRequest,
    );
  });

  it('silently ignores unknown notifications', async () => {
    const client = new McpTestClient(app());
    await client.notify('notifications/whatever');
  });
});

describe('cancellation and timeouts', () => {
  const slowTool = defineTool({
    name: 'slow',
    description: 'resolves only when aborted (never on its own)',
    inputSchema: z.object({}),
    handler: (_input, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () =>
          resolve({ content: [{ type: 'text', text: 'aborted' }] }),
        );
      }),
  });

  it('sends no response for requests cancelled via notifications/cancelled', async () => {
    const context = app({}, {
      registerCapabilities: (registry) => {
        registerAllCapabilities(registry);
        registry.registerTool(slowTool);
      },
    });
    const client = new McpTestClient(context);
    await client.initialize();

    const pending = client.requestRaw('tools/call', { name: 'slow', arguments: {} });
    const requestId = client.lastId;
    await new Promise((r) => setTimeout(r, 20));
    await client.notify('notifications/cancelled', { requestId, reason: 'user changed mind' });

    expect(await pending).toBeNull();
  });

  it('fails requests that exceed REQUEST_TIMEOUT_MS', async () => {
    const context = app({ REQUEST_TIMEOUT_MS: '50' }, {
      registerCapabilities: (registry) => registry.registerTool(slowTool),
    });
    const client = new McpTestClient(context);
    await client.initialize();

    const error = await client.requestExpectError('tools/call', { name: 'slow', arguments: {} });
    expect(error.message).toMatch(/timed out/);
  });
});

describe('progress', () => {
  it('forwards notifications/progress when the client sent a progressToken', async () => {
    const progressTool = defineTool({
      name: 'progressive',
      description: 'reports progress',
      inputSchema: z.object({}),
      handler: async (_input, ctx) => {
        await ctx.reportProgress(1, 2, 'halfway');
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    const context = app({}, {
      registerCapabilities: (registry) => registry.registerTool(progressTool),
    });
    const client = new McpTestClient(context);
    await client.initialize();

    const received: unknown[] = [];
    client.session.setSender((n) => void received.push(n));

    await client.request('tools/call', {
      name: 'progressive',
      arguments: {},
      _meta: { progressToken: 'tok-1' },
    });

    expect(received).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-1', progress: 1, total: 2, message: 'halfway' },
    });
  });
});
