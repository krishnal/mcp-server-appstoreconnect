/**
 * No-op provider: every caller is an anonymous, full-access principal.
 * Suitable for local development and trusted stdio deployments only.
 */
import {
  ANONYMOUS_FULL_ACCESS,
  type AuthContext,
  type AuthProvider,
  type Credentials,
} from '../types.js';

export class NoAuthProvider implements AuthProvider {
  readonly name = 'none';

  authenticate(_credentials: Credentials): Promise<AuthContext> {
    return Promise.resolve(ANONYMOUS_FULL_ACCESS);
  }
}
