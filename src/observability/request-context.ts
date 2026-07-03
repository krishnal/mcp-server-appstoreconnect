/**
 * Request-scoped context propagated via AsyncLocalStorage.
 *
 * Every JSON-RPC message is processed inside a context carrying a correlation
 * id. The logger mixes this into every log line automatically, so any log
 * emitted anywhere in a request's async call graph is correlatable without
 * threading ids through function signatures.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Correlation id (from `x-request-id`, Lambda request id, or generated). */
  requestId: string;
  /** MCP session id, when known. */
  sessionId?: string;
  /** JSON-RPC method being processed. */
  method?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function newRequestId(): string {
  return randomUUID();
}
