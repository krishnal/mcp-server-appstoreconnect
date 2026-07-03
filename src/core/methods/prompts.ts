/**
 * prompts/list and prompts/get.
 */
import { z } from 'zod';
import { JsonRpcError } from '../jsonrpc/errors.js';
import { paginate } from '../pagination.js';
import type { GetPromptResult } from '../protocol/types.js';
import { buildCapabilityContext } from './capability-context.js';
import { assertScopes } from './authorize.js';
import type { MethodDefinition } from './types.js';

const listParamsSchema = z.looseObject({ cursor: z.string().optional() }).optional();
type ListParams = z.output<typeof listParamsSchema>;

export const promptsListMethod: MethodDefinition<ListParams, unknown> = {
  method: 'prompts/list',
  paramsSchema: listParamsSchema,
  handler(params, ctx) {
    const page = paginate(ctx.registry.listPrompts(), params?.cursor);
    return { prompts: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  },
};

const getParamsSchema = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.string()).optional(),
});
type GetParams = z.output<typeof getParamsSchema>;

export const promptsGetMethod: MethodDefinition<GetParams, GetPromptResult> = {
  method: 'prompts/get',
  paramsSchema: getParamsSchema,
  async handler(params, ctx) {
    const prompt = ctx.registry.getPrompt(params.name);
    if (!prompt) {
      throw JsonRpcError.invalidParams(`Unknown prompt: ${params.name}`);
    }
    assertScopes(ctx.session.auth, prompt.requiredScopes, `prompt "${prompt.name}"`);

    let args: Record<string, string> = params.arguments ?? {};
    if (prompt.argumentsSchema) {
      const parsed = prompt.argumentsSchema.safeParse(args);
      if (!parsed.success) {
        throw JsonRpcError.fromZodError(parsed.error, `arguments for prompt "${prompt.name}"`);
      }
      args = parsed.data as Record<string, string>;
    }

    return prompt.handler(args, buildCapabilityContext(ctx));
  },
};
