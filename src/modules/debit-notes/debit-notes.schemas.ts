import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { isoDate, nonEmpty, quantity, timestamp } from '../../lib/validators.js';

export const DEBIT_NOTE_REASONS = [
  'return',
  'damaged',
  'short_supply',
  'rate_difference',
  'quality',
  'expired',
  'other',
] as const;

export const createDebitNoteBody = z.object({
  id: clientId,
  purchaseBillId: z.string().uuid(),
  documentDate: isoDate,
  reasonCode: z.enum(DEBIT_NOTE_REASONS),
  /**
   * Partial returns are the normal case, so lines are given by bill line
   * with a quantity rather than by item. Rates come from the original bill:
   * a return is priced at what was paid, not at today's price.
   */
  lines: z
    .array(
      z.object({
        id: clientId,
        purchaseBillLineId: z.string().uuid(),
        quantity,
      }),
    )
    .min(1)
    .max(500),
  /**
   * False when the goods are not going back — damaged or expired stock that
   * the supplier credits without collecting.
   */
  restock: z.boolean().default(true),
  notes: nonEmpty.max(500).optional(),
  issuedAt: timestamp,
});
export type CreateDebitNoteBody = z.infer<typeof createDebitNoteBody>;

export const listDebitNotesQuery = pageQuery.extend({
  supplierId: z.string().uuid().optional(),
  purchaseBillId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ListDebitNotesQuery = z.infer<typeof listDebitNotesQuery>;

export const voidDebitNoteBody = z.object({ reason: nonEmpty.max(200) });
