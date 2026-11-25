import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { isoDate, nonEmpty, positivePaise, timestamp } from '../../lib/validators.js';

const expectedTotals = z.object({
  grandTotal: z.number().int(),
  totalTax: z.number().int(),
  taxableAmount: z.number().int(),
});

export const createSalesDebitNoteBody = z
  .object({
    id: clientId,
    originalInvoiceId: z.string().uuid(),
    seriesId: z.string().uuid(),
    sequenceNo: z.number().int().positive().refine(Number.isSafeInteger),
    documentDate: isoDate,
    issuedAt: timestamp,
    correctionReason: z.enum(['value_increase', 'tax_undercharged']),
    lines: z
      .array(
        z.object({
          id: clientId,
          invoiceLineId: z.string().uuid(),
          /** Taxable value in paise, exclusive of tax. */
          amount: positivePaise,
          /** For `tax_undercharged`: the right rate less the rate charged. */
          differentialRatePercent: z.number().positive().max(100).optional(),
        }),
      )
      .nonempty(),
    notes: nonEmpty.optional(),
    expectedTotals: expectedTotals.optional(),
  })
  .superRefine((body, ctx) => {
    const wantsRate = body.correctionReason === 'tax_undercharged';
    body.lines.forEach((line, index) => {
      if ((line.differentialRatePercent !== undefined) !== wantsRate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index, 'differentialRatePercent'],
          message: wantsRate ? 'A tax correction needs the rate difference.' : 'Only a tax correction has a rate difference.',
        });
      }
    });
  });
export type CreateSalesDebitNoteBody = z.infer<typeof createSalesDebitNoteBody>;

export const createFinancialCreditNoteBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  customerId: z.string().uuid(),
  /** The bill it relates to, when there is one; a credit can also be general. */
  originalInvoiceId: z.string().uuid().optional(),
  seriesId: z.string().uuid(),
  sequenceNo: z.number().int().positive().refine(Number.isSafeInteger),
  documentDate: isoDate,
  issuedAt: timestamp,
  amount: positivePaise,
  reason: nonEmpty.max(280),
  notes: nonEmpty.optional(),
});
export type CreateFinancialCreditNoteBody = z.infer<typeof createFinancialCreditNoteBody>;

export const voidNoteBody = z.object({ reason: nonEmpty });

export const listNotesQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['issued', 'void']).optional(),
  customerId: z.string().uuid().optional(),
  originalInvoiceId: z.string().uuid().optional(),
});
export type ListNotesQuery = z.infer<typeof listNotesQuery>;
