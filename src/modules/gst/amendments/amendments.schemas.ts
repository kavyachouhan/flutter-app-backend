import { z } from 'zod';
import { clientId } from '../../../lib/ids.js';
import { gstin, isoDate, nonEmpty, paise, stateCode } from '../../../lib/validators.js';

const yearMonth = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');
const signedPaise = z.number().int();

const line = z.object({
  ratePercent: z.number().min(0).max(100),
  taxable: signedPaise,
  igst: signedPaise,
  cgst: signedPaise,
  sgst: signedPaise,
  cess: signedPaise,
});

export const createAmendmentBody = z.object({
  id: clientId,
  gstin,
  /** 'gstr1a': same period, before its GSTR-3B. 'later_gstr1': tables 9A/9C/10 of `reportPeriod`. */
  route: z.enum(['gstr1a', 'later_gstr1']),
  reportPeriod: yearMonth.optional(),
  target: z.union([
    z.object({
      document: z.object({
        table: z.enum(['invoices', 'credit_notes', 'sales_debit_notes']),
        id: z.string().uuid(),
      }),
    }),
    z.object({
      b2cs: z.object({
        originalPeriod: yearMonth,
        placeOfSupply: stateCode,
        ratePercent: z.number().min(0).max(100),
      }),
    }),
  ]),
  /** Only what changes; the rest is taken from what was reported. */
  revised: z.object({
    number: nonEmpty.max(16).optional(),
    date: isoDate.optional(),
    value: paise.optional(),
    placeOfSupply: stateCode.optional(),
    recipientGstin: gstin.optional(),
    reverseCharge: z.boolean().optional(),
    lines: z.array(line).min(1).max(100).optional(),
    b2csRatePercent: z.number().min(0).max(100).optional(),
    b2csValue: z
      .object({ taxable: signedPaise, igst: signedPaise, cgst: signedPaise, sgst: signedPaise, cess: signedPaise })
      .optional(),
  }),
  reason: nonEmpty.max(500),
});
export type CreateAmendmentBody = z.infer<typeof createAmendmentBody>;

export const listAmendmentsQuery = z.object({ gstin, reportPeriod: yearMonth.optional() });
export type ListAmendmentsQuery = z.infer<typeof listAmendmentsQuery>;
