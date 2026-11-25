import { z } from 'zod';
import { clientId } from '../../../lib/ids.js';
import { gstin, isoDate, nonEmpty, paise } from '../../../lib/validators.js';

const yearMonth = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');

/** Issues the recipient's invoice for a reverse-charge purchase (s.31(3)(f), Rule 47A). */
export const issueRcmSelfInvoiceBody = z.object({
  id: clientId,
  purchaseBillId: z.string().uuid(),
  /** Defaults to today. Due within 30 days of receiving the goods or services. */
  documentDate: isoDate.optional(),
});
export type IssueRcmSelfInvoiceBody = z.infer<typeof issueRcmSelfInvoiceBody>;

export const listRcmSelfInvoicesQuery = z.object({
  gstin: gstin.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ListRcmSelfInvoicesQuery = z.infer<typeof listRcmSelfInvoicesQuery>;

export const IMS_SECTIONS = ['b2b', 'b2ba', 'b2bdn', 'b2bdna', 'b2bcn', 'b2bcna', 'ecom', 'ecoma'] as const;

const imsAction = z
  .object({
    section: z.enum(IMS_SECTIONS),
    supplierGstin: gstin,
    documentNumber: nonEmpty.max(16),
    documentDate: isoDate,
    documentValue: paise.optional(),
    gstr2bInvoiceId: z.string().uuid().optional(),
    purchaseBillId: z.string().uuid().optional(),
    action: z.enum(['accept', 'reject', 'pending', 'no_action']),
    /** Accepted credit notes and downward amendments only (IMS Offline Utility v2.0 Read Me). */
    itcReductionRequired: z.boolean().optional(),
    declared: z
      .object({ igst: paise, cgst: paise, sgst: paise, cess: paise })
      .optional(),
    remarks: nonEmpty.max(250).optional(),
  })
  .superRefine((v, ctx) => {
    const reducible = ['b2bcn', 'b2bcna', 'b2ba', 'b2bdna', 'ecoma'].includes(v.section);
    if ((v.itcReductionRequired !== undefined || v.declared) && (v.action !== 'accept' || !reducible)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'ITC reduction is declared only on an accepted credit note or a downward amendment.',
        path: ['itcReductionRequired'],
      });
    }
    if (v.remarks && v.action !== 'reject' && v.action !== 'pending') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Remarks go with a reject or pending action.',
        path: ['remarks'],
      });
    }
  });

export const recordImsActionsBody = z.object({
  gstin,
  actions: z.array(imsAction).min(1).max(10_000),
});
export type RecordImsActionsBody = z.infer<typeof recordImsActionsBody>;

export const imsExportQuery = z.object({ gstin });

export const declareStatementBalanceBody = z.object({
  id: clientId,
  gstin,
  statement: z.enum(['ecrrs', 'rcm']),
  asOfPeriod: yearMonth,
  igst: z.number().int(),
  cgst: z.number().int(),
  sgst: z.number().int(),
  cess: z.number().int(),
  source: z.enum(['declared', 'portal_file']).default('declared'),
  note: nonEmpty.max(500).optional(),
});
export type DeclareStatementBalanceBody = z.infer<typeof declareStatementBalanceBody>;

export const statementBalancesQuery = z.object({ gstin });
