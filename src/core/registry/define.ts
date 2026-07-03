/**
 * Declarative capability definitions.
 *
 * A capability (tool / resource / prompt) is a plain object: metadata + Zod
 * schema + handler. The `defineX` helpers exist purely for type inference —
 * handler inputs are typed from the Zod schema with zero annotations at the
 * call site. Business logic never sees JSON-RPC.
 */
import type { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import type { AppConfig } from '../../config/index.js';
import type { Logger } from '../../observability/logger.js';
import type { Services } from '../../services/index.js';
import type {
  CallToolResult,
  GetPromptResult,
  Implementation,
  LoggingLevel,
  ResourceContents,
  ToolAnnotations,
} from '../protocol/types.js';

/** Safe, read-only view of the calling session. */
export interface SessionInfo {
  readonly id: string;
  readonly protocolVersion?: string;
  readonly clientInfo?: Implementation;
}

/**
 * Everything a capability handler may need, injected per invocation.
 * Handlers stay pure functions of (input, context) — trivially unit-testable.
 */
export interface CapabilityContext {
  readonly logger: Logger;
  readonly config: AppConfig;
  /** Domain services (ASC client, store, analyzer, issue providers). */
  readonly services: Services;
  readonly auth: AuthContext;
  readonly session: SessionInfo;
  /** Aborted on client cancellation or request timeout — honor it in long work. */
  readonly signal: AbortSignal;
  /** Sends `notifications/progress` if the client requested progress updates. */
  reportProgress(progress: number, total?: number, message?: string): Promise<void>;
  /** Sends `notifications/message` respecting the client's `logging/setLevel`. */
  mcpLog(level: LoggingLevel, data: unknown, loggerName?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  /** Unique tool name: `[a-zA-Z0-9_-]{1,128}`. */
  name: string;
  title?: string;
  description: string;
  inputSchema: Schema;
  /** When present, `structuredContent` is validated against it before send. */
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  /** Scopes required to call this tool (enforced by the dispatcher). */
  requiredScopes?: readonly string[];
  handler: (
    input: z.output<Schema>,
    ctx: CapabilityContext,
  ) => CallToolResult | Promise<CallToolResult>;
}

export function defineTool<Schema extends z.ZodType>(
  definition: ToolDefinition<Schema>,
): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  /** Exact URI, e.g. `system://info`. */
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  /** Whether clients may `resources/subscribe` to this resource. */
  subscribable?: boolean;
  requiredScopes?: readonly string[];
  handler: (
    uri: string,
    ctx: CapabilityContext,
  ) => ResourceContents[] | Promise<ResourceContents[]>;
}

export function defineResource(definition: ResourceDefinition): ResourceDefinition {
  return definition;
}

export interface ResourceTemplateDefinition {
  /**
   * URI template. `{var}` matches a single path segment; `{+var}` (reserved
   * expansion) matches greedily across `/` — use it for path-like variables,
   * e.g. `docs://{+path}`.
   */
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  subscribable?: boolean;
  requiredScopes?: readonly string[];
  handler: (
    uri: string,
    params: Record<string, string>,
    ctx: CapabilityContext,
  ) => ResourceContents[] | Promise<ResourceContents[]>;
}

export function defineResourceTemplate(
  definition: ResourceTemplateDefinition,
): ResourceTemplateDefinition {
  return definition;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface PromptDefinition<
  Schema extends z.ZodObject = z.ZodObject,
> {
  name: string;
  title?: string;
  description?: string;
  /**
   * Zod object of string-valued fields. Field optionality and `.describe()`
   * metadata are projected into the spec's `PromptArgument[]` automatically.
   */
  argumentsSchema?: Schema;
  requiredScopes?: readonly string[];
  handler: (
    args: z.output<Schema>,
    ctx: CapabilityContext,
  ) => GetPromptResult | Promise<GetPromptResult>;
}

export function definePrompt<Schema extends z.ZodObject>(
  definition: PromptDefinition<Schema>,
): PromptDefinition {
  return definition as unknown as PromptDefinition;
}
