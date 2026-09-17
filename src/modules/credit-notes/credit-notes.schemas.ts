import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { isoDate, nonEmpty, paise, quantity, timestamp } from '../../lib/validators.js';
import { TENDER_MODES } from '../invoices/invoices.schemas.js';

export const CREDIT_NOTE_REASONS = [
  'return',
  'damaged',
  'wrong_item',
  'price_correction',
  'quality',
  'other',
] as const;

export const REFUND_MODES = ['khata', ...TENDER_MODES] as const;

const returnLine = z.object({
  id: clientId,
  invoiceLineId: z.string().uuid(),
  /** Thousandths of a unit; at most what remains unreturned on the line. */
  quantity,
});

export const createCreditNoteBody = z.object({
  id: clientId,
  originalInvoiceId: z.string().uuid(),
  seriesId: z.string().uuid(),
  sequenceNo: z.number().int().positive().refine(Number.isSafeInteger),
  documentDate: isoDate,
  issuedAt: timestamp,
  lines: z.array(returnLine).nonempty(),
  reasonCode: z.enum(CREDIT_NOTE_REASONS),
  /** `khata` credits the customer ledger; a tender mode pays money out now. */
  refundMode: z.enum(REFUND_MODES),
  /** Defaults to the full credit note total. Less than that leaves the rest on the khata. */
  refundAmount: paise.optional(),
  /** false for damaged goods that must not return to saleable stock. */
  restock: z.boolean().optional(),
  /** Payment id for the refund row when money is paid out; client-generated for offline replay. */
  refundPaymentId: clientId.optional(),
  customFields: z.record(z.string()).optional(),
  notes: nonEmpty.optional(),
  /** The device's own computation, re-checked on the server. */
  expectedTotals: z
    .object({
      grandTotal: z.number().int(),
      totalTax: z.number().int(),
      taxableAmount: z.number().int(),
    })
    .optional(),
});
export type CreateCreditNoteBody = z.infer<typeof createCreditNoteBody>;

export const voidCreditNoteBody = z.object({ reason: nonEmpty });

export const listCreditNotesQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['issued', 'void']).optional(),
  customerId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  originalInvoiceId: z.string().uuid().optional(),
});
export type ListCreditNotesQuery = z.infer<typeof listCreditNotesQuery>;
