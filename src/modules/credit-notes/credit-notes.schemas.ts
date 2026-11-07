import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { CORRECTION_REASONS, RECIPIENT_REVERSAL_STATUSES } from '../../domain/gst/enums.js';
import { isoDate, nonEmpty, paise, positivePaise, quantity, timestamp } from '../../lib/validators.js';
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

const returnLine = z
  .object({
    id: clientId,
    invoiceLineId: z.string().uuid(),
    /** Thousandths of a unit; at most what remains unreturned on the line. */
    quantity: quantity.optional(),
    /** Instead of a quantity: taxable value credited with no goods coming back. */
    valueAmount: positivePaise.optional(),
    /** With `valueAmount`, for a wrong rate: the rate charged less the right rate. */
    differentialRatePercent: z.number().positive().max(100).optional(),
  })
  .refine((l) => (l.quantity !== undefined) !== (l.valueAmount !== undefined), {
    message: 'A line gives either a quantity or a value.',
  })
  .refine((l) => l.differentialRatePercent === undefined || l.valueAmount !== undefined, {
    message: 'A rate difference needs a value.',
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
  /**
   * The legal reason (D27). Omitted, it follows the lines: goods coming back are a return, value
   * credited alone is a value reduction.
   */
  correctionReason: z.enum(CORRECTION_REASONS).optional(),
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

/** s.34(2) proviso: whether a registered buyer has reversed the credit on this note. */
export const recipientReversalBody = z.object({ status: z.enum(RECIPIENT_REVERSAL_STATUSES) });

export const listCreditNotesQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['issued', 'void']).optional(),
  customerId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  originalInvoiceId: z.string().uuid().optional(),
});
export type ListCreditNotesQuery = z.infer<typeof listCreditNotesQuery>;
