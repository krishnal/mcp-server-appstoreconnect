/**
 * Composition root — lightweight dependency injection.
 *
 * We deliberately use explicit constructor wiring instead of a decorator
 * container (tsyringe et al.): no `reflect-metadata` shim, no ESM/decorator
 * friction, faster Lambda cold starts, and the dependency graph is readable
 * in one screen. Tests inject overrides through `CreateAppContextOptions`.
 */
import { createAuthProvider } from '../auth/index.js';
import type { AuthProvider } from '../auth/types.js';
import { registerAllCapabilities } from '../capabilities/index.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { Metrics } from '../observability/metrics.js';
import { createServices, type Services } from '../services/index.js';
import { Dispatcher } from './dispatcher.js';
import { createCoreMethodRegistry } from './methods/index.js';
import type { MethodRegistry } from './methods/types.js';
import { CapabilityRegistry } from './registry/capability-registry.js';
import { InMemorySessionStore, type SessionStore } from './session.js';
import { ResourceSubscriptionHub } from './subscriptions.js';

export interface AppContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly registry: CapabilityRegistry;
  readonly methods: MethodRegistry;
  readonly sessions: SessionStore;
  readonly subscriptions: ResourceSubscriptionHub;
  readonly authProvider: AuthProvider;
  readonly dispatcher: Dispatcher;
  readonly services: Services;
  /**
   * Entry point for business logic to push resource-change notifications to
   * subscribed clients.
   */
  notifyResourceUpdated(uri: string): Promise<void>;
  /** Release background resources (session sweeper, open sessions). */
  dispose(): void;
}

export interface CreateAppContextOptions {
  /** Pre-built config (tests, Lambda overrides). Defaults to `loadConfig()`. */
  config?: AppConfig;
  /** Route logs to stderr — REQUIRED for stdio transport. */
  logDestination?: 'stdout' | 'stderr';
  /** Inject a logger (tests use a silent one). */
  logger?: Logger;
  /**
   * Capability plug-in point. Defaults to `registerAllCapabilities`; pass
   * your own function to compose different capability sets per deployment.
   */
  registerCapabilities?: (registry: CapabilityRegistry) => void;
  /** Additional protocol methods (experimental/spec-preview features). */
  registerMethods?: (methods: MethodRegistry) => void;
  authProvider?: AuthProvider;
  sessionStore?: SessionStore;
  /** Inject domain services (tests use fakes). Defaults to `createServices`. */
  services?: Services;
}

export function createAppContext(options: CreateAppContextOptions = {}): AppContext {
  const config = options.config ?? loadConfig();

  const logger =
    options.logger ??
    createLogger({
      level: config.log.level,
      name: config.server.name,
      pretty: config.log.pretty && config.env === 'development',
      destination: options.logDestination ?? 'stdout',
    });

  const metrics = new Metrics({
    enabled: config.metrics.enabled,
    // Default process metrics are meaningless per-invocation on Lambda.
    collectDefault: !config.session.stateless,
  });

  const registry = new CapabilityRegistry();
  (options.registerCapabilities ?? registerAllCapabilities)(registry);

  const methods = createCoreMethodRegistry();
  options.registerMethods?.(methods);

  const subscriptions = new ResourceSubscriptionHub();

  const sessions: SessionStore =
    options.sessionStore ??
    new InMemorySessionStore({
      ttlMs: config.session.ttlMs,
      // Runs only after construction completes, so the reference is safe.
      onRemove: (session) => {
        subscriptions.dropSession(session);
        metrics.activeSessions.set(sessions.size);
      },
    });

  const authProvider = options.authProvider ?? createAuthProvider(config);

  const services = options.services ?? createServices(config, logger);

  const dispatcher = new Dispatcher(methods, {
    config,
    logger,
    metrics,
    registry,
    subscriptions,
    services,
  });

  // Broadcast capability list changes to every live session.
  registry.onListChanged((kind) => {
    sessions.forEach((session) => {
      void session.send({
        jsonrpc: '2.0',
        method: `notifications/${kind}/list_changed`,
      });
    });
  });

  return {
    config,
    logger,
    metrics,
    registry,
    methods,
    sessions,
    subscriptions,
    authProvider,
    dispatcher,
    services,
    notifyResourceUpdated: (uri) => subscriptions.notifyUpdated(uri),
    dispose: () => {
      sessions.dispose();
      services.dispose();
    },
  };
}
