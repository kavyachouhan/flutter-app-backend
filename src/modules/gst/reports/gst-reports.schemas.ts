import { z } from 'zod';
import { gstin, isoDate } from '../../../lib/validators.js';

export const TRANSACTION_KINDS = [
  'gstr1_sales',
  'gstr1_cdn',
  'gstr2_purchases',
  'gstr2_cdn',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const transactionReportQuery = z.object({
  kind: z.enum(TRANSACTION_KINDS),
  /** Omitted, the business's own GSTIN is used; a business with several must name one. */
  gstin: gstin.optional(),
  year: z.coerce.number().int().min(2017).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  /** "Don't consider non tax transactions", on by default as in the app's filter. */
  excludeNonTax: z.enum(['true', 'false']).default('true'),
});
export type TransactionReportQuery = z.infer<typeof transactionReportQuery>;

/** What to do with a table report: show it, or hand it over as a plain or CA workbook. */
export const REPORT_FORMATS = ['json', 'xlsx', 'ca'] as const;

const dateRangeShape = {
  gstin: gstin.optional(),
  from: isoDate,
  to: isoDate,
  format: z.enum(REPORT_FORMATS).default('json'),
};

/** From must not follow to, and the window is capped so a report cannot read years of bills. */
const sensibleRange = (v: { from: string; to: string }): boolean =>
  v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 800 * 86_400_000;
const rangeMessage = { message: 'from must be on or before to, and within about two years' };

export const hsnSalesQuery = z.object(dateRangeShape).refine(sensibleRange, rangeMessage);
export type HsnSalesQuery = z.infer<typeof hsnSalesQuery>;

export const SAC_TRANSACTIONS = [
  'all',
  'sale',
  'sale_return',
  'purchase',
  'purchase_return',
] as const;

export const sacQuery = z
  .object({ ...dateRangeShape, transaction: z.enum(SAC_TRANSACTIONS).default('all') })
  .refine(sensibleRange, rangeMessage);
export type SacQuery = z.infer<typeof sacQuery>;
