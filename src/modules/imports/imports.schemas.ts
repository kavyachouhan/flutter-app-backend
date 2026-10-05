import { z } from 'zod';
import { pageQuery } from '../../lib/pagination.js';

export const IMPORT_KINDS = ['items'] as const;

/**
 * Only `items` for now. The table's CHECK already allows customers,
 * suppliers and opening stock so the schema does not have to move when those
 * arrive, but accepting a kind with no analyser would create jobs that can
 * never leave `ingested`.
 */
export const createImportBody = z.object({
  kind: z.enum(IMPORT_KINDS),
  contentType: z.enum([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
  ]),
  sizeBytes: z.number().int().positive(),
  originalFilename: z.string().trim().max(255).optional(),
});
export type CreateImportBody = z.infer<typeof createImportBody>;

/**
 * An explicit `columnMap` comes from the mapping screen and replaces what
 * ingest guessed. Supplying it restarts analysis from row zero, because the
 * rows already analysed were judged against the old mapping.
 */
export const analyseBody = z.object({
  columnMap: z.record(z.string(), z.number().int().min(0)).optional(),
});
export type AnalyseBody = z.infer<typeof analyseBody>;

export const listRowsQuery = pageQuery.extend({
  action: z.enum(['pending', 'create', 'update', 'skip', 'error']).optional(),
});
export type ListRowsQuery = z.infer<typeof listRowsQuery>;

export const listImportsQuery = pageQuery;
export type ListImportsQuery = z.infer<typeof listImportsQuery>;
