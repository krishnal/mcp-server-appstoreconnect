/**
 * JSON-RPC error codes and the error type used throughout the core.
 *
 * Standard codes come from the JSON-RPC 2.0 spec. Implementation-defined
 * codes live in the server-error range (-32000..-32099); `-32002` matches the
 * MCP specification's "resource not found" example.
 */
import type { ZodError } from 'zod';
import type { JsonRpcErrorObject } from './types.js';

export const JsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const McpErrorCodes = {
  /** Request received before the `initialize` handshake completed. */
  ServerNotInitialized: -32000,
  /** Authentication failed (transport-level auth usually returns HTTP 401 instead). */
  Unauthorized: -32001,
  /** Per MCP spec examples: requested resource does not exist. */
  ResourceNotFound: -32002,
  /** Authenticated principal lacks the scopes required by a capability. */
  Forbidden: -32003,
} as const;

/**
 * Throwable JSON-RPC error. Anything a method handler throws that is NOT a
 * JsonRpcError is treated as an internal error and its message is NOT leaked
 * to the client.
 */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }

  toErrorObject(): JsonRpcErrorObject {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }

  static methodNotFound(method: string): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCodes.MethodNotFound, `Method not found: ${method}`);
  }

  static invalidParams(message: string, data?: unknown): JsonRpcError {
    return new JsonRpcError(JsonRpcErrorCodes.InvalidParams, message, data);
  }

  static fromZodError(err: ZodError, what = 'params'): JsonRpcError {
    return JsonRpcError.invalidParams(`Invalid ${what}`, {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  static resourceNotFound(uri: string): JsonRpcError {
    return new JsonRpcError(McpErrorCodes.ResourceNotFound, 'Resource not found', { uri });
  }

  static forbidden(what: string, missingScopes: readonly string[]): JsonRpcError {
    return new JsonRpcError(McpErrorCodes.Forbidden, `Access denied to ${what}`, {
      missingScopes,
    });
  }

  static notInitialized(): JsonRpcError {
    return new JsonRpcError(
      McpErrorCodes.ServerNotInitialized,
      'Server not initialized: send an "initialize" request first',
    );
  }

  static internal(requestId?: string): JsonRpcError {
    return new JsonRpcError(
      JsonRpcErrorCodes.InternalError,
      'Internal error',
      requestId ? { requestId } : undefined,
    );
  }
}
