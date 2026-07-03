/**
 * App Store Connect JWT authentication.
 *
 * ASC API tokens are ES256 JWTs signed with a team/individual API key (.p8):
 *   header:  { alg: "ES256", kid: <Key ID>, typ: "JWT" }
 *   payload: { iss: <Issuer ID>, iat, exp (≤ 20 min), aud: "appstoreconnect-v1" }
 *
 * Tokens are cached and re-minted proactively before expiry; `invalidate()`
 * forces a fresh token after an upstream 401 (e.g. key rotated).
 *
 * Security: the private key stays inside this module. It is never logged
 * (pino redaction is belt-and-braces) and never appears in error messages.
 */
import { readFile } from 'node:fs/promises';
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';

/** Token lifetime. Apple allows up to 20 minutes; stay comfortably under. */
const TOKEN_TTL_SECONDS = 15 * 60;
/** Re-mint when less than this much lifetime remains. */
const REFRESH_MARGIN_SECONDS = 2 * 60;

export interface AscKeyConfig {
  issuerId: string;
  keyId: string;
  /** PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`). */
  privateKeyPem: string;
}

/**
 * Resolve the .p8 private key from configuration: either a file path or a
 * base64-encoded PEM (for environments where files are awkward, e.g. Lambda).
 */
export async function resolvePrivateKeyPem(source: {
  privateKeyPath?: string;
  privateKeyBase64?: string;
}): Promise<string> {
  let pem: string;
  if (source.privateKeyBase64) {
    pem = Buffer.from(source.privateKeyBase64, 'base64').toString('utf8');
  } else if (source.privateKeyPath) {
    pem = await readFile(source.privateKeyPath, 'utf8');
  } else {
    throw new Error('No App Store Connect private key configured');
  }
  if (!pem.includes('BEGIN PRIVATE KEY')) {
    throw new Error(
      'App Store Connect private key is not a PKCS#8 PEM (.p8). Expected a "-----BEGIN PRIVATE KEY-----" block.',
    );
  }
  return pem;
}

export class AscTokenProvider {
  private key: CryptoKey | undefined;
  private token: string | undefined;
  private expiresAtMs = 0;

  constructor(
    private readonly config: AscKeyConfig,
    /** Injectable clock for tests. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a valid bearer token, minting a new one when near expiry. */
  async getToken(): Promise<string> {
    const nowMs = this.now();
    if (this.token && nowMs < this.expiresAtMs - REFRESH_MARGIN_SECONDS * 1000) {
      return this.token;
    }

    this.key ??= await importPKCS8(this.config.privateKeyPem, 'ES256');

    const iat = Math.floor(nowMs / 1000);
    const exp = iat + TOKEN_TTL_SECONDS;
    this.token = await new SignJWT({ aud: 'appstoreconnect-v1' })
      .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId, typ: 'JWT' })
      .setIssuer(this.config.issuerId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    this.expiresAtMs = exp * 1000;
    return this.token;
  }

  /** Drop the cached token (after an upstream 401). */
  invalidate(): void {
    this.token = undefined;
    this.expiresAtMs = 0;
  }
}
