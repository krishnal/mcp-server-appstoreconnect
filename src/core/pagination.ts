/**
 * Cursor-based pagination for the list methods (tools/list, resources/list,
 * prompts/list, ...) per the MCP spec.
 *
 * Cursors are opaque to clients: base64url-encoded offsets. Invalid cursors
 * yield `-32602 Invalid params` as the spec requires.
 */
import { JsonRpcError } from './jsonrpc/errors.js';

export const DEFAULT_PAGE_SIZE = 50;

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { offset?: unknown }).offset === 'number' &&
      Number.isInteger((parsed as { offset: number }).offset) &&
      (parsed as { offset: number }).offset >= 0
    ) {
      return (parsed as { offset: number }).offset;
    }
  } catch {
    // fall through to the error below
  }
  throw JsonRpcError.invalidParams('Invalid cursor');
}

export function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Page<T> {
  const offset = cursor === undefined ? 0 : decodeCursor(cursor);
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    items: [...page],
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
  };
}
