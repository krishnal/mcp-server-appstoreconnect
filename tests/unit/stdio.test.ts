import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createStdioTransport } from '../../src/adapters/stdio.js';
import type { AppContext } from '../../src/core/container.js';
import { createTestApp } from '../helpers/mcp-test-client.js';

let app: AppContext | undefined;
afterEach(() => {
  app?.dispose();
  app = undefined;
});

/** Drive the stdio transport through in-memory streams. */
function boot() {
  app = createTestApp();
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createStdioTransport(app, { input, output });
  transport.start();

  const lines: unknown[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });

  const nextLine = async (): Promise<unknown> => {
    const deadline = Date.now() + 2_000;
    while (lines.length === 0) {
      if (Date.now() > deadline) throw new Error('timed out waiting for stdio output');
      await new Promise((r) => setTimeout(r, 5));
    }
    return lines.shift();
  };

  return { input, transport, nextLine };
}

describe('stdio transport', () => {
  it('completes an initialize round trip over line-delimited JSON', async () => {
    const { input, transport, nextLine } = boot();

    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1.0.0' },
        },
      }) + '\n',
    );

    const response = (await nextLine()) as {
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(response.id).toBe(1);
    expect(response.result.protocolVersion).toBe('2025-06-18');

    // notification → no output; follow-up request works
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const listResponse = (await nextLine()) as { id: number; result: { tools: unknown[] } };
    expect(listResponse.id).toBe(2);
    expect(listResponse.result.tools.length).toBeGreaterThan(0);

    await transport.stop();
  });

  it('answers malformed JSON with a -32700 parse error', async () => {
    const { input, transport, nextLine } = boot();
    input.write('this is not json\n');
    const response = (await nextLine()) as { id: null; error: { code: number } };
    expect(response.error.code).toBe(-32700);
    expect(response.id).toBeNull();
    await transport.stop();
  });
});
