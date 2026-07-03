/**
 * Graceful shutdown orchestration.
 *
 * Runs registered hooks (server close, session store dispose, ...) on
 * SIGTERM/SIGINT with a hard deadline, and converts crash-path events
 * (uncaughtException / unhandledRejection) into logged, orderly exits.
 */
import type { Logger } from '../observability/logger.js';

export interface ShutdownHook {
  name: string;
  fn: () => Promise<void> | void;
}

export interface ShutdownOptions {
  logger: Logger;
  timeoutMs: number;
  hooks: ShutdownHook[];
}

export function registerShutdownHooks(options: ShutdownOptions): void {
  const { logger, timeoutMs, hooks } = options;
  let shuttingDown = false;

  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason, timeoutMs }, 'shutting down');

    const deadline = setTimeout(() => {
      logger.error('shutdown deadline exceeded, forcing exit');
      process.exit(exitCode || 1);
    }, timeoutMs);
    deadline.unref();

    for (const hook of hooks) {
      try {
        await hook.fn();
        logger.debug({ hook: hook.name }, 'shutdown hook completed');
      } catch (err) {
        logger.error({ err, hook: hook.name }, 'shutdown hook failed');
      }
    }

    logger.info('shutdown complete');
    process.exit(exitCode);
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
}
