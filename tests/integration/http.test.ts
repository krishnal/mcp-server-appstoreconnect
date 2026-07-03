import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../../src/adapters/http.js';
import type { AppContext } from '../../src/core/container.js';
import { createTestApp } from '../helpers/mcp-test-client.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function bootServer(env: Record<string, string> = {}): Promise<{
  server: FastifyInstance;
  app: AppContext;
}> {
  const app = createTestApp(env);
  const server = await buildHttpServer(app);
  await server.ready();
  cleanups.push(async () => {
    await server.close();
    app.dispose();
  });
  return { server, app };
}

const initializeMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-test', version: '1.0.0' },
  },
};

async function handshake(server: FastifyInstance, headers: Record<string, string> = {}) {
  const response = await server.inject({
    method: 'POST',
    url: '/mcp',
    headers,
    payload: initializeMessage,
  });
  expect(response.statusCode).toBe(200);
  const sessionId = response.headers['mcp-session-id'] as string;
  expect(sessionId).toBeTruthy();
  await server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...headers, 'mcp-session-id': sessionId },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  return sessionId;
}

describe('Streamable HTTP transport', () => {
  it('performs the full handshake and serves requests per session', async () => {
    const { server } = await bootServer();
    const sessionId = await handshake(server);

    const list = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().result.tools.length).toBeGreaterThan(0);

    const call = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_feedback', arguments: {} },
      },
    });
    // No ASC credentials in tests — answered from the (empty) local cache.
    expect(JSON.parse(call.json().result.content[0].text).count).toBe(0);
  });

  it('returns 202 with no body for notifications', async () => {
    const { server } = await bootServer();
    const sessionId = await handshake(server);
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', method: 'notifications/whatever' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('');
  });

  it('requires a session header after initialize (400) and rejects unknown sessions (404)', async () => {
    const { server } = await bootServer();
    await handshake(server);

    const missing = await server.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    });
    expect(missing.statusCode).toBe(400);

    const unknown = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': 'does-not-exist' },
      payload: { jsonrpc: '2.0', id: 6, method: 'tools/list' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('rejects JSON-RPC batch arrays (removed in 2025-06-18)', async () => {
    const { server } = await bootServer();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      payload: [initializeMessage],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects unsupported MCP-Protocol-Version headers', async () => {
    const { server } = await bootServer();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-protocol-version': '1900-01-01' },
      payload: initializeMessage,
    });
    expect(response.statusCode).toBe(400);
  });

  it('blocks non-localhost origins when no allowlist is configured', async () => {
    const { server } = await bootServer();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'https://evil.example.com' },
      payload: initializeMessage,
    });
    expect(response.statusCode).toBe(403);
  });

  it('terminates sessions via DELETE', async () => {
    const { server } = await bootServer();
    const sessionId = await handshake(server);

    const del = await server.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
    });
    expect(del.statusCode).toBe(200);

    const afterDelete = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 9, method: 'tools/list' },
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('enforces API-key auth with HTTP 401 at the edge', async () => {
    const { server } = await bootServer({ AUTH_MODE: 'api-key', API_KEYS: 'http-key:*' });

    const denied = await server.inject({ method: 'POST', url: '/mcp', payload: initializeMessage });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer');

    const sessionId = await handshake(server, { 'x-api-key': 'http-key' });
    expect(sessionId).toBeTruthy();
  });

  it('exposes operational endpoints', async () => {
    const { server } = await bootServer({ METRICS_ENABLED: 'true' });
    expect((await server.inject({ method: 'GET', url: '/healthz' })).json().status).toBe('ok');
    expect((await server.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);

    await handshake(server);
    const metrics = await server.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('mcp_rpc_requests_total');
  });
});

describe('stateless mode over HTTP', () => {
  it('serves requests without sessions and disables server-push endpoints', async () => {
    const { server } = await bootServer({ STATELESS: 'true' });

    const call = await server.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_feedback', arguments: {} },
      },
    });
    expect(call.statusCode).toBe(200);
    expect(JSON.parse(call.json().result.content[0].text).count).toBe(0);
    expect(call.headers['mcp-session-id']).toBeUndefined();

    const sse = await server.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream' },
    });
    expect(sse.statusCode).toBe(405);
  });
});
