/**
 * Auth provider factory — the single switch to extend when adding schemes.
 */
import type { AppConfig } from '../config/index.js';
import { ApiKeyAuthProvider } from './providers/api-key.js';
import { JwtAuthProvider } from './providers/jwt.js';
import { NoAuthProvider } from './providers/none.js';
import type { AuthProvider } from './types.js';

export * from './types.js';
export { ApiKeyAuthProvider } from './providers/api-key.js';
export { JwtAuthProvider } from './providers/jwt.js';
export { NoAuthProvider } from './providers/none.js';

export function createAuthProvider(config: AppConfig): AuthProvider {
  switch (config.auth.mode) {
    case 'none':
      return new NoAuthProvider();
    case 'api-key':
      return new ApiKeyAuthProvider(config.auth.apiKeys);
    case 'jwt':
      return new JwtAuthProvider(config.auth.jwt);
  }
}
