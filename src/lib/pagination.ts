/**
 * Keyset pagination. OFFSET gets slower with depth and skips or repeats rows
 * when a concurrent insert shifts the window — both visible in a long
 * catalogue scroll. Cursors are opaque base64url so clients cannot depend on
 * their shape.
 */
import { z } from 'zod';
import { env } from '../config/env.js';
import { ValidationError } from './errors.js';

export interface Cursor {
  /** Sort key of the last row returned. */
  k: string | number;
  /** Tie-breaker, so rows sharing a sort key are never skipped. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const cursorShape = z.object({ k: z.union([z.string(), z.number()]), id: z.string() });

export function decodeCursor(raw: string): Cursor {
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new ValidationError('The pagination cursor is not valid. Restart from the first page.');
  }
}

export const pageQuery = z.object({
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
});

export interface PageRequest {
  limit: number;
  cursor: Cursor | undefined;
}

export function parsePage(input: z.infer<typeof pageQuery>): PageRequest {
  return {
    limit: Math.min(input.limit ?? env.PAGE_SIZE_DEFAULT, env.PAGE_SIZE_MAX),
    cursor: input.cursor === undefined ? undefined : decodeCursor(input.cursor),
  };
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Expects `limit + 1` rows: the extra row proves another page exists without a COUNT. */
export function buildPage<T>(rows: T[], limit: number, toCursor: (row: T) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, nextCursor: hasMore && last ? encodeCursor(toCursor(last)) : null };
}
