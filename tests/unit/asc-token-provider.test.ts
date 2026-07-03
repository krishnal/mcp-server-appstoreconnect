import { exportPKCS8, generateKeyPair, decodeJwt, decodeProtectedHeader } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AscTokenProvider, resolvePrivateKeyPem } from '../../src/asc/token-provider.js';

let privateKeyPem: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
});

describe('AscTokenProvider', () => {
  const config = () => ({ issuerId: 'issuer-123', keyId: 'KEY123', privateKeyPem });

  it('mints an ES256 JWT with Apple’s required claims', async () => {
    const provider = new AscTokenProvider(config());
    const token = await provider.getToken();

    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });

    const claims = decodeJwt(token);
    expect(claims.iss).toBe('issuer-123');
    expect(claims.aud).toBe('appstoreconnect-v1');
    // 15-minute lifetime, comfortably under Apple's 20-minute cap.
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(15 * 60);
  });

  it('caches the token and refreshes it before expiry', async () => {
    let nowMs = 1_700_000_000_000;
    const provider = new AscTokenProvider(config(), () => nowMs);

    const first = await provider.getToken();
    nowMs += 60_000; // 1 minute later — still fresh
    expect(await provider.getToken()).toBe(first);

    nowMs += 13 * 60_000; // 14 minutes in — inside the 2-minute refresh margin
    const refreshed = await provider.getToken();
    expect(refreshed).not.toBe(first);
    expect(decodeJwt(refreshed).iat).toBe(Math.floor(nowMs / 1000));
  });

  it('invalidate() forces a fresh token', async () => {
    const provider = new AscTokenProvider(config());
    const first = await provider.getToken();
    provider.invalidate();
    const second = await provider.getToken();
    expect(second).not.toBe(first);
  });
});

describe('resolvePrivateKeyPem', () => {
  it('decodes a base64-encoded key', async () => {
    const pem = await resolvePrivateKeyPem({
      privateKeyBase64: Buffer.from(privateKeyPem, 'utf8').toString('base64'),
    });
    expect(pem).toBe(privateKeyPem);
  });

  it('rejects non-PKCS#8 content with a readable error', async () => {
    await expect(
      resolvePrivateKeyPem({
        privateKeyBase64: Buffer.from('not a key').toString('base64'),
      }),
    ).rejects.toThrow(/PKCS#8/);
  });

  it('rejects when no source is configured', async () => {
    await expect(resolvePrivateKeyPem({})).rejects.toThrow(/No App Store Connect private key/);
  });
});
