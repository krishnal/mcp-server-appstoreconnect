/**
 * Static API-key provider with per-key scopes.
 *
 * Keys are compared in constant time (hash-then-timingSafeEqual, which also
 * normalizes lengths) to avoid timing side channels. The audit `subject` is a
 * short digest of the key — never the key itself.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyEntry } from '../../config/index.js';
import { AuthError, type AuthContext, type AuthProvider, type Credentials } from '../types.js';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class ApiKeyAuthProvider implements AuthProvider {
  readonly name = 'api-key';
  private readonly entries: ReadonlyArray<{
    digest: Buffer;
    fingerprint: string;
    scopes: readonly string[];
  }>;

  constructor(keys: readonly ApiKeyEntry[]) {
    if (keys.length === 0) {
      throw new Error('ApiKeyAuthProvider requires at least one API key');
    }
    this.entries = keys.map((entry) => {
      const digest = sha256(entry.key);
      return {
        digest,
        fingerprint: digest.toString('hex').slice(0, 12),
        scopes: entry.scopes,
      };
    });
  }

  // async so failures are always rejections, never synchronous throws.
  async authenticate(credentials: Credentials): Promise<AuthContext> {
    // Accept the key via `x-api-key` or as a bearer token.
    const presented = credentials.apiKey ?? credentials.bearerToken;
    if (!presented) {
      throw new AuthError('Missing API key');
    }
    const presentedDigest = sha256(presented);
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, presentedDigest)) {
        return {
          authenticated: true,
          subject: `api-key:${entry.fingerprint}`,
          scopes: entry.scopes,
        };
      }
    }
    throw new AuthError('Invalid API key');
  }
}
