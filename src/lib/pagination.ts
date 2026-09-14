/**
 * Cursor pagination.
 *
 * Offset pagination (`LIMIT 20 OFFSET 4000`) is wrong here for two reasons:
 * Postgres still walks and discards the skipped rows, so deep pages get
 * linearly slower; and concurrent inserts shift the window, so a client
 * paging through a catalogue silently skips or repeats items.
 *
 * Cursors are opaque to clients by design. Encoding them as base64url stops
 * anyone building a dependency on the internal shape, which leaves us free to
 * change the sort key later without breaking deployed apps.
 */
import { ValidationError } from './errors.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The decoded cursor: the sort key of the last row the client received. */
export interface CursorPayload {
  /** Primary sort value — an ISO timestamp, a UUID, or a sequence number. */
  k: string | number;
  /** Tie-breaker id, so rows sharing a sort key are never skipped. */
  id?: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('k' in decoded) ||
      (typeof decoded.k !== 'string' && typeof decoded.k !== 'number')
    ) {
      throw new Error('malformed cursor payload');
    }

    const payload: CursorPayload = { k: decoded.k };
    if ('id' in decoded && typeof decoded.id === 'string') payload.id = decoded.id;
    return payload;
  } catch {
    // Never echo the cursor back — it is attacker-controlled input.
    throw new ValidationError('The pagination cursor is not valid. Restart from the first page.');
  }
}

export interface PageRequest {
  limit: number;
  cursor?: CursorPayload;
}

export function parsePageRequest(input: { limit?: number; cursor?: string }): PageRequest {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return input.cursor === undefined ? { limit } : { limit, cursor: decodeCursor(input.cursor) };
}

export interface Page<T> {
  data: T[];
  /** Cursor for the next page, or null when the caller has reached the end. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Builds a page from `limit + 1` rows.
 *
 * Fetching one extra row is how we know whether more exist without a second
 * COUNT query — which on a large tenant's invoice table would cost more than
 * the page itself.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
  };
}
