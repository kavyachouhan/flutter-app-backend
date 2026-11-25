import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';

/**
 * What can be imported. The table's CHECK also allows `opening_stock`, which
 * has no handler: opening stock arrives as a column of an item import
 * instead, and accepting a kind with no handler would create jobs that can
 * never leave `ingested`.
 */
export const IMPORT_KINDS = ['items', 'customers', 'suppliers'] as const;

export const IMPORT_CONTENT_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // The Excel 97–2003 .xls that Vyapar and others still export.
  'application/vnd.ms-excel',
  'text/csv',
] as const;

export const createImportBody = z.object({
  id: clientId.optional(),
  kind: z.enum(IMPORT_KINDS),
  contentType: z.enum(IMPORT_CONTENT_TYPES),
  sizeBytes: z.number().int().positive(),
  originalFilename: z.string().trim().max(255).optional(),
  /** Items only: where an opening stock column is recorded. Without one, stock is not set. */
  outletId: z.string().uuid().optional(),
});
export type CreateImportBody = z.infer<typeof createImportBody>;

/**
 * An explicit `columnMap` comes from the matching screen and replaces what
 * ingest guessed. Supplying it restarts analysis from row zero, because the
 * rows already analysed were judged against the old mapping. With `remember`
 * (the default) it is also saved, so the next file with the same headers
 * skips the matching screen.
 */
export const analyseBody = z.object({
  columnMap: z.record(z.string(), z.number().int().min(0)).optional(),
  remember: z.boolean().default(true),
});
export type AnalyseBody = z.infer<typeof analyseBody>;

export const listRowsQuery = pageQuery.extend({
  action: z.enum(['pending', 'create', 'update', 'skip', 'error']).optional(),
});
export type ListRowsQuery = z.infer<typeof listRowsQuery>;

export const listImportsQuery = pageQuery;
export type ListImportsQuery = z.infer<typeof listImportsQuery>;
