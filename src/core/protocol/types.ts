/**
 * MCP protocol primitives (spec revision 2025-06-18).
 *
 * Wire-format types for everything the server sends to clients. Kept in one
 * place so a spec revision is a single, reviewable diff.
 */

// ---------------------------------------------------------------------------
// Implementations & capabilities
// ---------------------------------------------------------------------------

export interface Implementation {
  name: string;
  version: string;
  title?: string;
}

export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
  elicitation?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, never>;
  completions?: Record<string, never>;
  experimental?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
  instructions?: string;
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  /** base64-encoded image data */
  data: string;
  mimeType: string;
}

export interface AudioContent {
  type: 'audio';
  /** base64-encoded audio data */
  data: string;
  mimeType: string;
}

export interface EmbeddedResource {
  type: 'resource';
  resource: ResourceContents;
}

export interface ResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | EmbeddedResource
  | ResourceLink;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** JSON Schema object (already converted from Zod). */
export type JsonSchemaObject = Record<string, unknown>;

export interface McpToolListEntry {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations?: ToolAnnotations;
}

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface TextResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface BlobResourceContents {
  uri: string;
  mimeType?: string;
  /** base64-encoded binary data */
  blob: string;
}

export type ResourceContents = TextResourceContents | BlobResourceContents;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: ContentBlock;
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export const LOGGING_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const;

export type LoggingLevel = (typeof LOGGING_LEVELS)[number];

export function loggingLevelSeverity(level: LoggingLevel): number {
  return LOGGING_LEVELS.indexOf(level);
}
