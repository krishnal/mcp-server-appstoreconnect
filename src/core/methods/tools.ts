/**
 * tools/list and tools/call.
 *
 * Error-handling contract (per spec): protocol problems (unknown tool, bad
 * arguments, missing scopes) are JSON-RPC errors; tool EXECUTION failures are
 * successful responses with `isError: true` so the LLM can see and react to
 * them.
 */
import { z } from 'zod';
import { withSpan } from '../../observability/tracing.js';
import { JsonRpcError } from '../jsonrpc/errors.js';
import { paginate } from '../pagination.js';
import type { CallToolResult } from '../protocol/types.js';
import { buildCapabilityContext } from './capability-context.js';
import { assertScopes } from './authorize.js';
import type { MethodContext, MethodDefinition } from './types.js';

const listParamsSchema = z.looseObject({ cursor: z.string().optional() }).optional();
type ListParams = z.output<typeof listParamsSchema>;

export const toolsListMethod: MethodDefinition<ListParams, unknown> = {
  method: 'tools/list',
  paramsSchema: listParamsSchema,
  handler(params, ctx) {
    const page = paginate(ctx.registry.listTools(), params?.cursor);
    return { tools: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  },
};

const callParamsSchema = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
type CallParams = z.output<typeof callParamsSchema>;

async function executeTool(params: CallParams, ctx: MethodContext): Promise<CallToolResult> {
  const tool = ctx.registry.getTool(params.name);
  if (!tool) {
    throw JsonRpcError.invalidParams(`Unknown tool: ${params.name}`);
  }

  try {
    assertScopes(ctx.session.auth, tool.requiredScopes, `tool "${tool.name}"`);
  } catch (err) {
    ctx.metrics.toolCalls.inc({ tool: tool.name, outcome: 'denied' });
    throw err;
  }

  const parsed = tool.inputSchema.safeParse(params.arguments ?? {});
  if (!parsed.success) {
    throw JsonRpcError.fromZodError(parsed.error, `arguments for tool "${tool.name}"`);
  }

  return withSpan('mcp.tool.call', { 'mcp.tool.name': tool.name }, async () => {
    try {
      const result = await tool.handler(parsed.data, buildCapabilityContext(ctx));

      // Guard the contract: structured output must match the declared schema.
      if (tool.outputSchema && result.structuredContent !== undefined) {
        const validated = tool.outputSchema.safeParse(result.structuredContent);
        if (!validated.success) {
          ctx.logger.error(
            { tool: tool.name, issues: validated.error.issues },
            'tool returned structuredContent that violates its outputSchema',
          );
          ctx.metrics.toolCalls.inc({ tool: tool.name, outcome: 'error' });
          return {
            content: [{ type: 'text', text: `Tool "${tool.name}" produced invalid output` }],
            isError: true,
          };
        }
      }

      // Spec recommendation: mirror structuredContent as text for older clients.
      if (result.structuredContent !== undefined && result.content.length === 0) {
        result.content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
      }

      ctx.metrics.toolCalls.inc({
        tool: tool.name,
        outcome: result.isError ? 'error' : 'ok',
      });
      return result;
    } catch (err) {
      // A JsonRpcError thrown by the tool is intentional — let it surface as
      // a protocol error (e.g. resource-not-found from a resource-backed tool).
      if (err instanceof JsonRpcError) throw err;

      // Anything else is a business failure: report it IN the result so the
      // model can self-correct, and never leak stack traces.
      ctx.logger.warn({ err, tool: tool.name }, 'tool execution failed');
      ctx.metrics.toolCalls.inc({ tool: tool.name, outcome: 'error' });
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Tool "${tool.name}" failed: ${message}` }],
        isError: true,
      };
    }
  });
}

export const toolsCallMethod: MethodDefinition<CallParams, CallToolResult> = {
  method: 'tools/call',
  paramsSchema: callParamsSchema,
  handler: executeTool,
};
