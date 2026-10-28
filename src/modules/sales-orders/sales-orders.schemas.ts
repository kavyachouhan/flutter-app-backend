import { z } from 'zod';
import { attachmentsField } from '../../lib/attachments.js';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import {
  declaredSupplyType,
  hsnCode,
  isoDate,
  nonEmpty,
  paise,
  quantity,
  stateCode,
  supplyCategory,
} from '../../lib/validators.js';
import { REFUND_MODES } from '../credit-notes/credit-notes.schemas.js';
import { additionalCharge, discount, TENDER_MODES } from '../invoices/invoices.schemas.js';
import { discountApproval } from '../price-lists/price-lists.schemas.js';

export const SALES_ORDER_STATUSES = ['open', 'partial', 'closed', 'cancelled'] as const;

const orderLine = z
  .object({
    id: clientId,
    itemId: z.string().uuid().nullable().optional(),
    /** Required for a custom line with no catalogue item. Such a line never reserves stock. */
    itemName: nonEmpty.max(200).optional(),
    hsnCode: hsnCode.optional(),
    unit: nonEmpty.max(20).optional(),
    quantity,
    unitPrice: paise,
    discount: discount.optional(),
    taxRatePercent: z.number().nonnegative(),
    cessRatePercent: z.number().nonnegative().optional(),
    supplyCategory: supplyCategory.optional(),
  })
  .refine((l) => l.itemId || l.itemName, {
    message: 'itemName is required without itemId',
    path: ['itemName'],
  });

// Attachments use the shared shape in `lib/attachments.ts`: the same one every
// other document takes, so an order's files look like a bill's.

/** The order is stored whole; an edit replaces the same shape. */
export const saleOrderBody = z.object({
  outletId: z.string().uuid(),
  documentDate: isoDate,
  dueDate: isoDate.nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  /** Used when the order is for a walk-in who is not a saved customer. */
  customerName: nonEmpty.max(120).nullable().optional(),
  customerPhone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{7,20}$/, 'must be a valid phone number')
    .nullable()
    .optional(),
  placeOfSupplyStateCode: stateCode.nullable().optional(),
  supplyType: declaredSupplyType.optional(),
  /** Reverse charge: the recipient pays the tax, so the order carries none. */
  isReverseCharge: z.boolean().optional(),
  pricesIncludeTax: z.boolean(),
  roundOff: z.boolean(),
  /** May be empty: an order can be taken for a typed amount with no items. */
  lines: z.array(orderLine).max(500),
  /** Paise. Only for an order with no lines; rejected alongside lines. */
  manualTotal: paise.nullable().optional(),
  billDiscount: discount.optional(),
  /** Why the bill discount was given. */
  billDiscountReason: nonEmpty.max(280).nullable().optional(),
  additionalCharges: z.array(additionalCharge).max(20).optional(),
  advanceAmount: paise.default(0),
  paymentMode: z.enum(TENDER_MODES).nullable().optional(),
  notes: nonEmpty.max(1000).nullable().optional(),
  /** Values for the tenant's user-defined fields; validated against the definitions. */
  customFields: z.record(z.string()).optional(),
  attachments: attachmentsField.optional(),
  /** A saved T&C; its text is snapshotted onto the order. null clears it. */
  termsId: z.string().uuid().nullable().optional(),
  /**
   * Approvals for discounts over the shop's policy. An order is typed online, so a
   * discount over policy without one is refused rather than warned about.
   */
  discountApprovals: z.array(discountApproval).max(50).optional(),
  /** The device's own computation, re-checked on the server. */
  expectedTotals: z.object({
    grandTotal: z.number().int(),
    totalTax: z.number().int(),
    taxableAmount: z.number().int(),
  }),
});

export const createSaleOrderBody = saleOrderBody.extend({ id: clientId });
export type CreateSaleOrderBody = z.infer<typeof createSaleOrderBody>;

export const updateSaleOrderBody = saleOrderBody;
export type UpdateSaleOrderBody = z.infer<typeof updateSaleOrderBody>;

export const listSaleOrdersQuery = pageQuery.extend({
  status: z.enum(['all', 'open', 'partial', 'closed']).optional(),
  customerId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  /** Matches the order number, customer name or phone. */
  q: nonEmpty.max(80).optional(),
});
export type ListSaleOrdersQuery = z.infer<typeof listSaleOrdersQuery>;

export const summarySaleOrdersQuery = z.object({ outletId: z.string().uuid().optional() });
export type SummarySaleOrdersQuery = z.infer<typeof summarySaleOrdersQuery>;

/**
 * What to do with the advance that has not been used. Omitted, it is paid back the way it
 * was taken; `khata` leaves it as the customer's credit instead.
 */
const refundMode = z.enum(REFUND_MODES);

export const cancelSaleOrderBody = z.object({
  reason: nonEmpty.max(200),
  refundMode: refundMode.optional(),
});
export type CancelSaleOrderBody = z.infer<typeof cancelSaleOrderBody>;

export const closeSaleOrderBody = z.object({ refundMode: refundMode.optional() }).default({});
export type CloseSaleOrderBody = z.infer<typeof closeSaleOrderBody>;

export const deleteSaleOrderQuery = z.object({ refundMode: refundMode.optional() });
export type DeleteSaleOrderQuery = z.infer<typeof deleteSaleOrderQuery>;
