/**
 * Pluggable authentication.
 *
 * Transports extract raw credentials from their medium (HTTP headers, Lambda
 * event headers, ...) into a transport-neutral `Credentials` object, then ask
 * the configured `AuthProvider` to authenticate. The resulting `AuthContext`
 * travels with the session and is consulted by the dispatcher for
 * per-capability scope checks.
 *
 * To add a new scheme (OAuth2 introspection, mTLS, HMAC, ...):
 *   1. implement `AuthProvider` in `src/auth/providers/`,
 *   2. wire it in `createAuthProvider` (src/auth/index.ts),
 *   3. add any config to `src/config/index.ts`.
 * No transport or core code changes required.
 */

export interface Credentials {
  /** Value of `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Value of the `x-api-key` header. */
  apiKey?: string;
}

export interface AuthContext {
  readonly authenticated: boolean;
  /** Stable principal identifier for logging/audit (never a secret). */
  readonly subject: string;
  /** Granted scopes. The wildcard scope `*` grants everything. */
  readonly scopes: readonly string[];
  /** Provider-specific claims (e.g. decoded JWT payload). */
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface AuthProvider {
  readonly name: string;
  /** Return an AuthContext or throw {@link AuthError}. */
  authenticate(credentials: Credentials): Promise<AuthContext>;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Full-access context used by trusted local transports (stdio) and tests. */
export const ANONYMOUS_FULL_ACCESS: AuthContext = Object.freeze({
  authenticated: true,
  subject: 'anonymous',
  scopes: Object.freeze(['*']),
});

/** Case-insensitive credential extraction from header maps. */
export function extractCredentials(
  headers: Record<string, string | string[] | undefined>,
): Credentials {
  const get = (name: string): string | undefined => {
    const direct = headers[name] ?? headers[name.toLowerCase()];
    const found =
      direct ??
      Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    return Array.isArray(found) ? found[0] : found;
  };

  const credentials: Credentials = {};
  const authorization = get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    credentials.bearerToken = authorization.slice(7).trim();
  }
  const apiKey = get('x-api-key');
  if (apiKey) credentials.apiKey = apiKey;
  return credentials;
}

export function hasScopes(auth: AuthContext, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  if (auth.scopes.includes('*')) return true;
  return required.every((scope) => auth.scopes.includes(scope));
}
