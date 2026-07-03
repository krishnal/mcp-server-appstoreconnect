/**
 * Per-capability authorization: verifies the session's auth context carries
 * the scopes a capability declared via `requiredScopes`.
 */
import { hasScopes, type AuthContext } from '../../auth/types.js';
import { JsonRpcError } from '../jsonrpc/errors.js';

export function assertScopes(
  auth: AuthContext,
  required: readonly string[] | undefined,
  what: string,
): void {
  if (!required || required.length === 0) return;
  if (!hasScopes(auth, required)) {
    throw JsonRpcError.forbidden(
      what,
      required.filter((scope) => !auth.scopes.includes(scope)),
    );
  }
}
