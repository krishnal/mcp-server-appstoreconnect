import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { ApiKeyAuthProvider } from '../../src/auth/providers/api-key.js';
import { JwtAuthProvider } from '../../src/auth/providers/jwt.js';
import { NoAuthProvider } from '../../src/auth/providers/none.js';
import { AuthError, extractCredentials, hasScopes } from '../../src/auth/types.js';

describe('extractCredentials', () => {
  it('reads bearer tokens and API keys case-insensitively', () => {
    expect(
      extractCredentials({ Authorization: 'Bearer tok-123', 'X-API-Key': 'key-1' }),
    ).toEqual({ bearerToken: 'tok-123', apiKey: 'key-1' });
  });

  it('ignores non-bearer authorization schemes', () => {
    expect(extractCredentials({ authorization: 'Basic dXNlcg==' })).toEqual({});
  });
});

describe('NoAuthProvider', () => {
  it('grants anonymous wildcard access', async () => {
    const auth = await new NoAuthProvider().authenticate({});
    expect(auth.scopes).toContain('*');
  });
});

describe('ApiKeyAuthProvider', () => {
  const provider = new ApiKeyAuthProvider([
    { key: 'secret-key-1', scopes: ['tools:fetch'] },
    { key: 'admin-key', scopes: ['*'] },
  ]);

  it('authenticates via x-api-key header', async () => {
    const auth = await provider.authenticate({ apiKey: 'secret-key-1' });
    expect(auth.authenticated).toBe(true);
    expect(auth.scopes).toEqual(['tools:fetch']);
    // audit subject is a fingerprint, never the key itself
    expect(auth.subject).toMatch(/^api-key:[0-9a-f]{12}$/);
    expect(auth.subject).not.toContain('secret-key-1');
  });

  it('accepts the key as a bearer token too', async () => {
    const auth = await provider.authenticate({ bearerToken: 'admin-key' });
    expect(auth.scopes).toEqual(['*']);
  });

  it('rejects missing and unknown keys', async () => {
    await expect(provider.authenticate({})).rejects.toThrow(AuthError);
    await expect(provider.authenticate({ apiKey: 'wrong' })).rejects.toThrow(AuthError);
  });
});

describe('JwtAuthProvider', () => {
  const secret = 'test-secret-with-sufficient-length';
  const key = new TextEncoder().encode(secret);
  const provider = new JwtAuthProvider({ secret, issuer: 'test-issuer' });

  async function sign(overrides: Record<string, unknown> = {}, expiresIn = '5m'): Promise<string> {
    return new SignJWT({ scope: 'tools:fetch resources:read', ...overrides })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-42')
      .setIssuer('test-issuer')
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(key);
  }

  it('verifies tokens and extracts subject and scopes', async () => {
    const auth = await provider.authenticate({ bearerToken: await sign() });
    expect(auth.subject).toBe('user-42');
    expect(auth.scopes).toEqual(['tools:fetch', 'resources:read']);
  });

  it('rejects missing, tampered and expired tokens', async () => {
    await expect(provider.authenticate({})).rejects.toThrow(AuthError);

    const token = await sign();
    await expect(
      provider.authenticate({ bearerToken: token.slice(0, -2) + 'xx' }),
    ).rejects.toThrow(AuthError);

    const expired = await sign({}, '-1m');
    await expect(provider.authenticate({ bearerToken: expired })).rejects.toThrow(AuthError);
  });

  it('rejects wrong issuer', async () => {
    const badIssuer = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('evil-issuer')
      .setExpirationTime('5m')
      .sign(key);
    await expect(provider.authenticate({ bearerToken: badIssuer })).rejects.toThrow(AuthError);
  });
});

describe('hasScopes', () => {
  const auth = { authenticated: true, subject: 's', scopes: ['a', 'b'] } as const;

  it('requires every listed scope', () => {
    expect(hasScopes(auth, ['a'])).toBe(true);
    expect(hasScopes(auth, ['a', 'b'])).toBe(true);
    expect(hasScopes(auth, ['a', 'c'])).toBe(false);
    expect(hasScopes(auth, [])).toBe(true);
  });

  it('honors the wildcard scope', () => {
    expect(hasScopes({ ...auth, scopes: ['*'] }, ['anything'])).toBe(true);
  });
});
