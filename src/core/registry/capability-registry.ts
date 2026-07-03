/**
 * Central capability registry.
 *
 * The single source of truth for what this server exposes. Protocol method
 * handlers only ever query the registry — they never know about concrete
 * capabilities — so adding a domain is: write a module, register it in
 * `src/capabilities/index.ts`, done.
 *
 * Zod schemas are converted to JSON Schema once at registration time and
 * cached; `tools/list` responses are cheap.
 */
import { z } from 'zod';
import type {
  JsonSchemaObject,
  McpPrompt,
  McpResource,
  McpResourceTemplate,
  McpToolListEntry,
  PromptArgument,
  ServerCapabilities,
} from '../protocol/types.js';
import type {
  PromptDefinition,
  ResourceDefinition,
  ResourceTemplateDefinition,
  ToolDefinition,
} from './define.js';
import { compileUriTemplate, type CompiledUriTemplate } from './uri-template.js';

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export type ListChangedKind = 'tools' | 'resources' | 'prompts';

export type ResourceMatch =
  | { kind: 'direct'; definition: ResourceDefinition }
  | { kind: 'template'; definition: ResourceTemplateDefinition; params: Record<string, string> };

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchemaObject {
  const { $schema: _discarded, ...rest } = z.toJSONSchema(schema, { io }) as Record<
    string,
    unknown
  >;
  return rest;
}

/** Project a Zod object schema into the spec's `PromptArgument[]` shape. */
function promptArguments(schema: z.ZodObject | undefined): PromptArgument[] | undefined {
  if (!schema) return undefined;
  const args: PromptArgument[] = [];
  for (const [name, field] of Object.entries(schema.shape)) {
    const fieldSchema = field as z.ZodType;
    const required = !fieldSchema.safeParse(undefined).success;
    const description = fieldSchema.description;
    args.push({ name, ...(description ? { description } : {}), ...(required ? { required } : {}) });
  }
  return args;
}

export class CapabilityRegistry {
  private readonly tools = new Map<
    string,
    { definition: ToolDefinition; listEntry: McpToolListEntry }
  >();
  private readonly resources = new Map<string, ResourceDefinition>();
  private readonly resourceTemplates = new Map<
    string,
    { definition: ResourceTemplateDefinition; compiled: CompiledUriTemplate }
  >();
  private readonly prompts = new Map<string, { definition: PromptDefinition; listEntry: McpPrompt }>();
  private readonly listChangedListeners = new Set<(kind: ListChangedKind) => void>();

  // -- registration ---------------------------------------------------------

  registerTool(definition: ToolDefinition): this {
    if (!TOOL_NAME_PATTERN.test(definition.name)) {
      throw new Error(`Invalid tool name "${definition.name}" (expected ${TOOL_NAME_PATTERN})`);
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    const listEntry: McpToolListEntry = {
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      description: definition.description,
      inputSchema: toJsonSchema(definition.inputSchema, 'input'),
      ...(definition.outputSchema
        ? { outputSchema: toJsonSchema(definition.outputSchema, 'output') }
        : {}),
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
    };
    this.tools.set(definition.name, { definition, listEntry });
    this.emitListChanged('tools');
    return this;
  }

  registerResource(definition: ResourceDefinition): this {
    if (this.resources.has(definition.uri)) {
      throw new Error(`Resource already registered: ${definition.uri}`);
    }
    this.resources.set(definition.uri, definition);
    this.emitListChanged('resources');
    return this;
  }

  registerResourceTemplate(definition: ResourceTemplateDefinition): this {
    if (this.resourceTemplates.has(definition.uriTemplate)) {
      throw new Error(`Resource template already registered: ${definition.uriTemplate}`);
    }
    this.resourceTemplates.set(definition.uriTemplate, {
      definition,
      compiled: compileUriTemplate(definition.uriTemplate),
    });
    this.emitListChanged('resources');
    return this;
  }

  registerPrompt(definition: PromptDefinition): this {
    if (this.prompts.has(definition.name)) {
      throw new Error(`Prompt already registered: ${definition.name}`);
    }
    const args = promptArguments(definition.argumentsSchema);
    const listEntry: McpPrompt = {
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      ...(args && args.length > 0 ? { arguments: args } : {}),
    };
    this.prompts.set(definition.name, { definition, listEntry });
    this.emitListChanged('prompts');
    return this;
  }

  // -- queries --------------------------------------------------------------

  listTools(): McpToolListEntry[] {
    return [...this.tools.values()].map((t) => t.listEntry);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  listResources(): McpResource[] {
    return [...this.resources.values()].map((r) => ({
      uri: r.uri,
      name: r.name,
      ...(r.title ? { title: r.title } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      ...(r.size !== undefined ? { size: r.size } : {}),
    }));
  }

  listResourceTemplates(): McpResourceTemplate[] {
    return [...this.resourceTemplates.values()].map(({ definition: t }) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(t.mimeType ? { mimeType: t.mimeType } : {}),
    }));
  }

  /** Resolve a concrete URI to a direct resource or a template match. */
  findResource(uri: string): ResourceMatch | undefined {
    const direct = this.resources.get(uri);
    if (direct) return { kind: 'direct', definition: direct };
    for (const { definition, compiled } of this.resourceTemplates.values()) {
      const params = compiled.match(uri);
      if (params) return { kind: 'template', definition, params };
    }
    return undefined;
  }

  listPrompts(): McpPrompt[] {
    return [...this.prompts.values()].map((p) => p.listEntry);
  }

  getPrompt(name: string): PromptDefinition | undefined {
    return this.prompts.get(name)?.definition;
  }

  /** Server capabilities advertised in the `initialize` result. */
  serverCapabilities(): ServerCapabilities {
    const capabilities: ServerCapabilities = { logging: {} };
    if (this.tools.size > 0) {
      capabilities.tools = { listChanged: true };
    }
    if (this.resources.size > 0 || this.resourceTemplates.size > 0) {
      capabilities.resources = { subscribe: true, listChanged: true };
    }
    if (this.prompts.size > 0) {
      capabilities.prompts = { listChanged: true };
    }
    return capabilities;
  }

  // -- change notifications ---------------------------------------------------

  /**
   * Subscribe to list-change events (used to broadcast the
   * `notifications/<kind>/list_changed` messages to connected sessions).
   * Returns an unsubscribe function.
   */
  onListChanged(listener: (kind: ListChangedKind) => void): () => void {
    this.listChangedListeners.add(listener);
    return () => this.listChangedListeners.delete(listener);
  }

  private emitListChanged(kind: ListChangedKind): void {
    for (const listener of this.listChangedListeners) {
      listener(kind);
    }
  }
}
