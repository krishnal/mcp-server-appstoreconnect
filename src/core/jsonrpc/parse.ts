/**
 * Shared wire-level JSON parsing for all transports.
 */
import { JsonRpcErrorCodes } from './errors.js';
import { errorResponse, type JsonRpcErrorResponse } from './types.js';

export type ParseOutcome =
  | { ok: true; value: unknown }
  | { ok: false; response: JsonRpcErrorResponse };

export function parseJsonRpc(text: string): ParseOutcome {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: errorResponse(null, {
        code: JsonRpcErrorCodes.ParseError,
        message: 'Parse error: invalid JSON',
      }),
    };
  }
}
