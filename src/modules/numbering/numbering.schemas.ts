import { z } from 'zod';
import { clientId } from '../../lib/ids.js';

/**
 * Must stay a subset of the `document_series_document_type_check` CHECK,
 * which migration 0007 widened ahead of the features that use it. Purchase
 * documents were added when M11 started issuing numbers for them.
 */
export const DOCUMENT_TYPES = [
  'invoice',
  'credit_note',
  'debit_note',
  'payment_receipt',
  'purchase_order',
  'purchase_bill',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const createSeriesBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  counterId: z.string().uuid().nullable(),
  documentType: z.enum(DOCUMENT_TYPES),
  fyStartYear: z.number().int().positive(),
  prefix: z.string().regex(/^[A-Za-z0-9-]+$/, 'letters, digits and hyphens only'),
  includeOutletCode: z.boolean(),
  includeCounterCode: z.boolean(),
  includeFinancialYear: z.boolean(),
  padding: z.number().int().positive(),
  separator: z.enum(['/', '-']),
  /** Lets a business migrating mid-year continue its existing series. */
  startingSequence: z.number().int().positive().refine(Number.isSafeInteger),
});
export type CreateSeriesBody = z.infer<typeof createSeriesBody>;

export const listSeriesQuery = z.object({
  outletId: z.string().uuid().optional(),
  counterId: z.string().uuid().optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  fyStartYear: z.coerce.number().int().positive().optional(),
});
export type ListSeriesQuery = z.infer<typeof listSeriesQuery>;

export const leaseBody = z.object({ blockSize: z.number().int().positive().optional() });
export type LeaseBody = z.infer<typeof leaseBody>;
