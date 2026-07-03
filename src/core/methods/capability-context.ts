/**
 * Bridges the protocol layer to business logic: builds the transport- and
 * protocol-agnostic `CapabilityContext` a tool/resource/prompt handler sees.
 */
import { loggingLevelSeverity, type LoggingLevel } from '../protocol/types.js';
import type { CapabilityContext } from '../registry/define.js';
import type { MethodContext } from './types.js';

export function buildCapabilityContext(ctx: MethodContext): CapabilityContext {
  const { session, progressToken } = ctx;

  return {
    logger: ctx.logger,
    config: ctx.config,
    services: ctx.services,
    auth: session.auth,
    session: session.info,
    signal: ctx.signal,

    async reportProgress(progress, total, message) {
      // Only meaningful when the client attached a progress token (_meta).
      if (progressToken === undefined) return;
      await session.send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      });
    },

    async mcpLog(level: LoggingLevel, data, loggerName) {
      // Per spec: the server SHOULD NOT send log messages before the client
      // sets a level, and MUST respect the threshold afterwards.
      if (session.loggingLevel === undefined) return;
      if (loggingLevelSeverity(level) < loggingLevelSeverity(session.loggingLevel)) return;
      await session.send({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level, data, ...(loggerName ? { logger: loggerName } : {}) },
      });
    },
  };
}
