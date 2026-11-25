import { z } from 'zod';
import { clientId } from '../../../lib/ids.js';
import { gstin, isoDate, nonEmpty, positivePaise, stateCode } from '../../../lib/validators.js';

export const createReceiptVoucherBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  /** The payment (khata receipt or order advance) this voucher documents. */
  paymentId: z.string().uuid().optional(),
  documentDate: isoDate.optional(),
  /** Goods advances carry no tax for a regular taxpayer (66/2017-CT); services do. */
  supplyKind: z.enum(['goods', 'services']),
  /** Omitted: the customer's state, and if that is unknown the supply is treated as inter-State. */
  placeOfSupply: stateCode.optional(),
  /** Omitted: not determinable, 18% (Rule 50 proviso). */
  ratePercent: z.number().min(0).max(100).optional(),
  reverseCharge: z.boolean().optional(),
  /** Amount received, including tax. */
  amount: positivePaise,
  description: nonEmpty.max(300).optional(),
});
export type CreateReceiptVoucherBody = z.infer<typeof createReceiptVoucherBody>;

export const refundAdvanceBody = z.object({
  id: clientId,
  documentDate: isoDate.optional(),
  amount: positivePaise,
});
export type RefundAdvanceBody = z.infer<typeof refundAdvanceBody>;

export const adjustAdvanceBody = z.object({
  invoiceId: z.string().uuid(),
  /** Part of the advance (as received, tax-inclusive) consumed by the invoice. */
  amount: positivePaise,
});
export type AdjustAdvanceBody = z.infer<typeof adjustAdvanceBody>;

export const listReceiptVouchersQuery = z.object({
  gstin: gstin.optional(),
  customerId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ListReceiptVouchersQuery = z.infer<typeof listReceiptVouchersQuery>;
