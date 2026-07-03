/**
 * Protocol-compliance test helpers.
 *
 * `createTestApp` builds a fully wired app context with a silent logger and
 * test-friendly config. `McpTestClient` drives the dispatcher exactly like a
 * transport would — use it to assert protocol behavior for any capability
 * you add, without booting a real transport.
 */
import { expect } from 'vitest';
import { ANONYMOUS_FULL_ACCESS, type AuthContext } from '../../src/auth/types.js';
import { loadConfig } from '../../src/config/index.js';
import {
  createAppContext,
  type AppContext,
  type CreateAppContextOptions,
} from '../../src/core/container.js';
import type {
  JsonRpcErrorObject,
  JsonRpcResponse,
  RequestId,
} from '../../src/core/jsonrpc/types.js';
import { LATEST_PROTOCOL_VERSION } from '../../src/core/protocol/versions.js';
import type { Session } from '../../src/core/session.js';
import { createSilentLogger } from '../../src/observability/logger.js';

export function createTestApp(
  env: Record<string, string> = {},
  options: Omit<CreateAppContextOptions, 'config' | 'logger'> = {},
): AppContext {
  const config = loadConfig({
    NODE_ENV: 'test',
    METRICS_ENABLED: 'false',
    LOG_PRETTY: 'false',
    STATE_DB_PATH: ':memory:',
    ...env,
  });
  return createAppContext({ config, logger: createSilentLogger(), ...options });
}

export class McpTestClient {
  readonly session: Session;
  lastId: RequestId = 0;
  private nextId = 1;

  constructor(
    private readonly app: AppContext,
    auth: AuthContext = ANONYMOUS_FULL_ACCESS,
  ) {
    this.session = app.sessions.create(auth);
  }

  /** Send a request; returns the full JSON-RPC response (or null). */
  requestRaw(method: string, params?: unknown): Promise<JsonRpcResponse | null> {
    this.lastId = this.nextId++;
    return this.app.dispatcher.handleMessage(
      {
        jsonrpc: '2.0',
        id: this.lastId,
        method,
        ...(params !== undefined ? { params } : {}),
      },
      this.session,
    );
  }

  /** Send a request; unwrap `result` or fail the test on error. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.requestRaw(method, params);
    expect(response, `expected a response for ${method}`).not.toBeNull();
    if (response && 'error' in response) {
      throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    }
    return (response as { result: T }).result;
  }

  /** Send a request expected to fail; returns the JSON-RPC error object. */
  async requestExpectError(method: string, params?: unknown): Promise<JsonRpcErrorObject> {
    const response = await this.requestRaw(method, params);
    expect(response, `expected an error response for ${method}`).not.toBeNull();
    if (!response || !('error' in response)) {
      throw new Error(`${method} unexpectedly succeeded: ${JSON.stringify(response)}`);
    }
    return response.error;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const response = await this.app.dispatcher.handleMessage(
      { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) },
      this.session,
    );
    expect(response, 'notifications must not produce responses').toBeNull();
  }

  /** Full initialize handshake (initialize + notifications/initialized). */
  async initialize(protocolVersion: string = LATEST_PROTOCOL_VERSION): Promise<unknown> {
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
    return result;
  }
}
