/**
 * Lifecycle methods: initialize / notifications/initialized / ping,
 * plus logging/setLevel.
 */
import { z } from 'zod';
import { JsonRpcError, JsonRpcErrorCodes } from '../jsonrpc/errors.js';
import {
  LOGGING_LEVELS,
  type InitializeResult,
} from '../protocol/types.js';
import { negotiateProtocolVersion } from '../protocol/versions.js';
import type { MethodDefinition } from './types.js';

const initializeParamsSchema = z.looseObject({
  protocolVersion: z.string(),
  capabilities: z.looseObject({}).default({}),
  clientInfo: z
    .looseObject({
      name: z.string(),
      version: z.string(),
      title: z.string().optional(),
    })
    .optional(),
});

type InitializeParams = z.output<typeof initializeParamsSchema>;

export const initializeMethod: MethodDefinition<InitializeParams, InitializeResult> = {
  method: 'initialize',
  paramsSchema: initializeParamsSchema,
  allowBeforeInitialization: true,
  handler(params, ctx) {
    const { session, config, registry } = ctx;
    if (session.state !== 'new') {
      throw new JsonRpcError(
        JsonRpcErrorCodes.InvalidRequest,
        'Session already initialized',
      );
    }

    session.protocolVersion = negotiateProtocolVersion(params.protocolVersion);
    if (params.clientInfo) {
      session.clientInfo = {
        name: params.clientInfo.name,
        version: params.clientInfo.version,
        ...(params.clientInfo.title ? { title: params.clientInfo.title } : {}),
      };
    }
    session.clientCapabilities = params.capabilities;
    session.state = 'initializing';

    ctx.logger.info(
      {
        client: session.clientInfo?.name,
        requestedVersion: params.protocolVersion,
        negotiatedVersion: session.protocolVersion,
      },
      'session initialized',
    );

    return {
      protocolVersion: session.protocolVersion,
      capabilities: registry.serverCapabilities(),
      serverInfo: { name: config.server.name, version: config.server.version },
      ...(config.server.instructions ? { instructions: config.server.instructions } : {}),
    };
  },
};

export const initializedNotification: MethodDefinition<unknown, void> = {
  method: 'notifications/initialized',
  allowBeforeInitialization: true,
  handler(_params, ctx) {
    if (ctx.session.state === 'initializing') {
      ctx.session.state = 'ready';
    }
  },
};

export const pingMethod: MethodDefinition<unknown, Record<string, never>> = {
  method: 'ping',
  allowBeforeInitialization: true,
  handler() {
    return {};
  },
};

const setLevelParamsSchema = z.looseObject({ level: z.enum(LOGGING_LEVELS) });

export const setLoggingLevelMethod: MethodDefinition<
  z.output<typeof setLevelParamsSchema>,
  Record<string, never>
> = {
  method: 'logging/setLevel',
  paramsSchema: setLevelParamsSchema,
  handler(params, ctx) {
    ctx.session.loggingLevel = params.level;
    return {};
  },
};
