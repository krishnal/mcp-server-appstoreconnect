import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, describe, expect, it } from 'vitest';
import { createLambdaHandler } from '../../src/adapters/lambda.js';
import type { AppContext } from '../../src/core/container.js';
import { createTestApp } from '../helpers/mcp-test-client.js';

let app: AppContext | undefined;
afterEach(() => {
  app?.dispose();
  app = undefined;
});

function makeHandler(env: Record<string, string> = {}) {
  app = createTestApp({ STATELESS: 'true', ...env });
  return createLambdaHandler(app);
}

function event(
  body: unknown,
  overrides: { method?: string; headers?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /mcp',
    rawPath: '/mcp',
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...overrides.headers },
    requestContext: {
      http: { method: overrides.method ?? 'POST', path: '/mcp' },
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const lambdaContext = { awsRequestId: 'test-invocation-id' } as Context;

function parseBody(result: Awaited<ReturnType<ReturnType<typeof makeHandler>>>): any {
  const response = result as { statusCode: number; body?: string };
  return response.body ? JSON.parse(response.body) : undefined;
}

describe('lambda adapter (stateless)', () => {
  it('handles initialize without a session header', async () => {
    const handler = makeHandler();
    const result = await handler(
      event({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'lambda-test', version: '1.0.0' },
        },
      }),
      lambdaContext,
    );
    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(parseBody(result).result.serverInfo.name).toBe('testflight-mcp-server');
  });

  it('serves tool calls with no prior handshake (ephemeral sessions)', async () => {
    const handler = makeHandler();
    const result = await handler(
      event({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_feedback', arguments: {} },
      }),
      lambdaContext,
    );
    // No ASC credentials in tests — the tool answers from the (empty) local cache.
    const payload = JSON.parse(parseBody(result).result.content[0].text);
    expect(payload.count).toBe(0);
  });

  it('returns 202 for notifications', async () => {
    const handler = makeHandler();
    const result = await handler(
      event({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      lambdaContext,
    );
    expect((result as { statusCode: number }).statusCode).toBe(202);
  });

  it('rejects non-POST methods and malformed JSON', async () => {
    const handler = makeHandler();
    const getResult = await handler(event({}, { method: 'GET' }), lambdaContext);
    expect((getResult as { statusCode: number }).statusCode).toBe(405);

    const badJson = await handler(event('{oops'), lambdaContext);
    expect((badJson as { statusCode: number }).statusCode).toBe(400);
    expect(parseBody(badJson).error.code).toBe(-32700);
  });

  it('enforces authentication at the edge', async () => {
    const handler = makeHandler({ AUTH_MODE: 'api-key', API_KEYS: 'lambda-key:*' });

    const denied = await handler(
      event({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      lambdaContext,
    );
    expect((denied as { statusCode: number }).statusCode).toBe(401);

    const allowed = await handler(
      event(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { headers: { 'x-api-key': 'lambda-key' } },
      ),
      lambdaContext,
    );
    expect((allowed as { statusCode: number }).statusCode).toBe(200);
  });
});
