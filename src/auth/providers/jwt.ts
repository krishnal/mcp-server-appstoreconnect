/**
 * JWT bearer-token provider (via `jose`).
 *
 * Supports either a shared HS256 secret (JWT_SECRET) or an asymmetric JWKS
 * endpoint (JWT_JWKS_URL — e.g. an OAuth2/OIDC authorization server), with
 * optional issuer/audience enforcement.
 *
 * Scopes are read from the standard OAuth2 `scope` claim (space-delimited)
 * or a `scopes` array claim.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthError, type AuthContext, type AuthProvider, type Credentials } from '../types.js';

export interface JwtAuthOptions {
  secret?: string;
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
}

function extractScopes(payload: JWTPayload): string[] {
  if (typeof payload['scope'] === 'string') {
    return payload['scope'].split(' ').filter(Boolean);
  }
  if (Array.isArray(payload['scopes'])) {
    return payload['scopes'].filter((s): s is string => typeof s === 'string');
  }
  return [];
}

export class JwtAuthProvider implements AuthProvider {
  readonly name = 'jwt';
  private readonly key:
    | Uint8Array
    | ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: JwtAuthOptions) {
    if (options.jwksUrl) {
      this.key = createRemoteJWKSet(new URL(options.jwksUrl));
    } else if (options.secret) {
      this.key = new TextEncoder().encode(options.secret);
    } else {
      throw new Error('JwtAuthProvider requires a secret or a JWKS URL');
    }
  }

  async authenticate(credentials: Credentials): Promise<AuthContext> {
    if (!credentials.bearerToken) {
      throw new AuthError('Missing bearer token');
    }
    try {
      const { payload } = await jwtVerify(
        credentials.bearerToken,
        // jose accepts either a symmetric key or a JWKS resolver here; the
        // union confuses its overloads, hence the cast.
        this.key as Uint8Array,
        {
          ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
          ...(this.options.audience ? { audience: this.options.audience } : {}),
        },
      );
      return {
        authenticated: true,
        subject: payload.sub ?? 'jwt:unknown-subject',
        scopes: extractScopes(payload),
        claims: payload as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('Invalid or expired token');
    }
  }
}
