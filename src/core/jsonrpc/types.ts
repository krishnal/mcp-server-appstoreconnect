/**
 * JSON-RPC 2.0 message types and classification.
 *
 * This module is transport-agnostic and dependency-free: every transport
 * (stdio, HTTP, Lambda, future WebSocket) funnels raw parsed JSON through
 * `classifyMessage` before dispatch.
 */

export const JSONRPC_VERSION = '2.0' as const;

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type ClassifiedMessage =
  | { type: 'request'; message: JsonRpcRequest }
  | { type: 'notification'; message: JsonRpcNotification }
  | { type: 'response'; message: JsonRpcResponse }
  | { type: 'invalid'; id: RequestId | null; reason: string };

function isValidId(id: unknown): id is RequestId {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

/**
 * Structurally classify an already-parsed JSON value as a JSON-RPC message.
 * Returns `invalid` (never throws) so callers can build a proper error
 * response carrying the offending id when one is recoverable.
 */
export function classifyMessage(raw: unknown): ClassifiedMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { type: 'invalid', id: null, reason: 'Message must be a JSON object' };
  }
  const msg = raw as Record<string, unknown>;
  const recoveredId = isValidId(msg['id']) ? msg['id'] : null;

  if (msg['jsonrpc'] !== JSONRPC_VERSION) {
    return { type: 'invalid', id: recoveredId, reason: 'Missing or invalid "jsonrpc" version (expected "2.0")' };
  }

  // Responses (client answering a server-initiated request) carry result/error.
  if (!('method' in msg)) {
    if ('result' in msg || 'error' in msg) {
      return { type: 'response', message: raw as JsonRpcResponse };
    }
    return { type: 'invalid', id: recoveredId, reason: 'Message has neither "method" nor "result"/"error"' };
  }

  if (typeof msg['method'] !== 'string' || msg['method'].length === 0) {
    return { type: 'invalid', id: recoveredId, reason: '"method" must be a non-empty string' };
  }
  if ('params' in msg && msg['params'] !== undefined) {
    const p = msg['params'];
    if (typeof p !== 'object' || p === null) {
      return { type: 'invalid', id: recoveredId, reason: '"params" must be a structured value (object or array)' };
    }
  }

  if ('id' in msg && msg['id'] !== undefined && msg['id'] !== null) {
    if (!isValidId(msg['id'])) {
      return { type: 'invalid', id: null, reason: '"id" must be a string or a finite number' };
    }
    return { type: 'request', message: raw as JsonRpcRequest };
  }

  return { type: 'notification', message: raw as JsonRpcNotification };
}

export function successResponse(id: RequestId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorResponse(id: RequestId | null, error: JsonRpcErrorObject): JsonRpcErrorResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error };
}
