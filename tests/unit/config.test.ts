import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/index.js';

describe('config', () => {
  it('loads sane defaults from an empty environment', () => {
    const config = loadConfig({});
    expect(config.server.name).toBe('mcp-server-appstoreconnect');
    expect(config.transport).toBe('http');
    expect(config.http.port).toBe(3000);
    expect(config.auth.mode).toBe('none');
    expect(config.session.stateless).toBe(false);
  });

  it('coerces numbers and booleans from env strings', () => {
    const config = loadConfig({ HTTP_PORT: '8080', STATELESS: 'true', RATE_LIMIT_ENABLED: 'false' });
    expect(config.http.port).toBe(8080);
    expect(config.session.stateless).toBe(true);
    expect(config.rateLimit.enabled).toBe(false);
  });

  it('parses API keys with per-key scopes (scopes may contain colons)', () => {
    const config = loadConfig({
      AUTH_MODE: 'api-key',
      API_KEYS: 'key-a:tools:fetch|resources:read,plain-key',
    });
    expect(config.auth.apiKeys).toHaveLength(2);
    expect(config.auth.apiKeys[0]).toEqual({
      key: 'key-a',
      scopes: ['tools:fetch', 'resources:read'],
    });
    expect(config.auth.apiKeys[1]).toEqual({ key: 'plain-key', scopes: ['*'] });
  });

  it('rejects api-key mode without keys', () => {
    expect(() => loadConfig({ AUTH_MODE: 'api-key' })).toThrow(ConfigError);
  });

  it('rejects jwt mode without secret or JWKS URL', () => {
    expect(() => loadConfig({ AUTH_MODE: 'jwt' })).toThrow(ConfigError);
  });

  it('rejects invalid enum values with a readable report', () => {
    expect(() => loadConfig({ AUTH_MODE: 'saml' })).toThrow(/AUTH_MODE/);
  });
});
