/**
 * resources/list, resources/templates/list, resources/read,
 * resources/subscribe, resources/unsubscribe.
 */
import { z } from 'zod';
import { JsonRpcError } from '../jsonrpc/errors.js';
import { paginate } from '../pagination.js';
import { buildCapabilityContext } from './capability-context.js';
import { assertScopes } from './authorize.js';
import type { MethodContext, MethodDefinition } from './types.js';

const listParamsSchema = z.looseObject({ cursor: z.string().optional() }).optional();
type ListParams = z.output<typeof listParamsSchema>;

const uriParamsSchema = z.looseObject({ uri: z.string().min(1) });
type UriParams = z.output<typeof uriParamsSchema>;

export const resourcesListMethod: MethodDefinition<ListParams, unknown> = {
  method: 'resources/list',
  paramsSchema: listParamsSchema,
  handler(params, ctx) {
    const page = paginate(ctx.registry.listResources(), params?.cursor);
    return {
      resources: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

export const resourceTemplatesListMethod: MethodDefinition<ListParams, unknown> = {
  method: 'resources/templates/list',
  paramsSchema: listParamsSchema,
  handler(params, ctx) {
    const page = paginate(ctx.registry.listResourceTemplates(), params?.cursor);
    return {
      resourceTemplates: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

function resolveResource(uri: string, ctx: MethodContext) {
  const match = ctx.registry.findResource(uri);
  if (!match) throw JsonRpcError.resourceNotFound(uri);
  assertScopes(ctx.session.auth, match.definition.requiredScopes, `resource "${uri}"`);
  return match;
}

export const resourcesReadMethod: MethodDefinition<UriParams, unknown> = {
  method: 'resources/read',
  paramsSchema: uriParamsSchema,
  async handler(params, ctx) {
    const match = resolveResource(params.uri, ctx);
    const capabilityCtx = buildCapabilityContext(ctx);
    const contents =
      match.kind === 'direct'
        ? await match.definition.handler(params.uri, capabilityCtx)
        : await match.definition.handler(params.uri, match.params, capabilityCtx);
    return { contents };
  },
};

export const resourcesSubscribeMethod: MethodDefinition<UriParams, Record<string, never>> = {
  method: 'resources/subscribe',
  paramsSchema: uriParamsSchema,
  handler(params, ctx) {
    const match = resolveResource(params.uri, ctx);
    if (match.definition.subscribable === false) {
      throw JsonRpcError.invalidParams(`Resource does not support subscriptions: ${params.uri}`);
    }
    ctx.subscriptions.subscribe(ctx.session, params.uri);
    return {};
  },
};

export const resourcesUnsubscribeMethod: MethodDefinition<UriParams, Record<string, never>> = {
  method: 'resources/unsubscribe',
  paramsSchema: uriParamsSchema,
  handler(params, ctx) {
    ctx.subscriptions.unsubscribe(ctx.session, params.uri);
    return {};
  },
};
