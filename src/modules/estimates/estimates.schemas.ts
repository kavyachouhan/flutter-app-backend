import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { isoDate, nonEmpty } from '../../lib/validators.js';
import { discountApproval } from '../price-lists/price-lists.schemas.js';
import { saleOrderBody } from '../sales-orders/sales-orders.schemas.js';

export const ESTIMATE_STATUSES = ['open', 'converted', 'closed', 'cancelled'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const ESTIMATE_CONVERSION_TARGETS = ['sales_order', 'invoice'] as const;

/**
 * An estimate has the same shape as a sales order, minus everything about money received
 * and stock promised: no advance, no payment mode, and no discount approvals (the shop's
 * discount policy is enforced when the estimate becomes an order). `validUntil` takes the
 * place of the order's due date.
 */
export const estimateBody = saleOrderBody
  .omit({ dueDate: true, advanceAmount: true, paymentMode: true, discountApprovals: true })
  .extend({
    /** The last day the quoted prices hold. */
    validUntil: isoDate.nullable().optional(),
  });

export const createEstimateBody = estimateBody.extend({ id: clientId });
export type CreateEstimateBody = z.infer<typeof createEstimateBody>;

export const updateEstimateBody = estimateBody;
export type UpdateEstimateBody = z.infer<typeof updateEstimateBody>;

export const listEstimatesQuery = pageQuery.extend({
  /** `closed` covers everything no longer open: converted, closed by hand and cancelled. */
  status: z.enum(['all', 'open', 'closed']).optional(),
  customerId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  /** Matches the estimate number, customer name or phone. */
  q: nonEmpty.max(80).optional(),
});
export type ListEstimatesQuery = z.infer<typeof listEstimatesQuery>;

export const summaryEstimatesQuery = z.object({ outletId: z.string().uuid().optional() });
export type SummaryEstimatesQuery = z.infer<typeof summaryEstimatesQuery>;

export const cancelEstimateBody = z.object({ reason: nonEmpty.max(200) });
export type CancelEstimateBody = z.infer<typeof cancelEstimateBody>;

/**
 * Only `sales_order` is performed here. An invoice is numbered from the till's own leased
 * block, so the device raises it and names this estimate on the invoice instead.
 */
export const convertEstimateBody = z.object({
  /** The id the new order will carry, so a retried request cannot raise two. */
  id: clientId,
  target: z.literal('sales_order'),
  /** Approvals for discounts over the shop's policy, as on a sales order. */
  discountApprovals: z.array(discountApproval).max(50).optional(),
});
export type ConvertEstimateBody = z.infer<typeof convertEstimateBody>;
