import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import {
  booleanQuery,
  gstRate,
  hsnCode,
  isoDate,
  nonEmpty,
  paise,
  positivePaise,
  quantity,
  stateCode,
  supplyCategory,
  timestamp,
} from '../../lib/validators.js';

const discount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount'), value: paise }),
  z.object({ kind: z.literal('percent'), value: z.number().min(0).max(100) }),
]);

const purchaseLine = z.object({
  id: clientId,
  itemId: z.string().uuid(),
  /** Snapshot: the name as it appeared on the supplier's bill. */
  itemName: nonEmpty.optional(),
  hsnCode: hsnCode.optional(),
  unit: nonEmpty.optional(),
  quantity,
  /** What the supplier charged per unit, before tax unless pricesIncludeTax. */
  unitPrice: paise,
  taxRatePercent: gstRate,
  cessRatePercent: z.number().min(0).max(100).default(0),
  discount: discount.optional(),
  /** Omitted, the item's own classification applies, then `taxable`. */
  supplyCategory: supplyCategory.optional(),
  /** Links the receipt to a purchase order line, for partial receipt. */
  purchaseOrderLineId: z.string().uuid().optional(),
});

export const createPurchaseBillBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  supplierId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
  documentDate: isoDate,
  /** The number printed on the supplier's own bill. */
  supplierInvoiceNo: nonEmpty.max(64),
  supplierInvoiceDate: isoDate,
  dueDate: isoDate.optional(),
  placeOfSupplyStateCode: stateCode.optional(),
  pricesIncludeTax: z.boolean().default(false),
  roundOff: z.boolean().default(true),
  /**
   * Whether the GST on this bill is reclaimable. Default true for a
   * registered dealer; the service overrides it to false when the business
   * is unregistered or on composition, because such a dealer never reclaims.
   */
  itcEligible: z.boolean().default(true),
  /**
   * How the credit is classified. GSTR-3B table 4 splits input tax credit
   * four ways and `itcEligible` alone cannot fill it. Defaults to `inputs`,
   * which is what a shop buying stock is almost always claiming.
   */
  itcCategory: z
    .enum(['inputs', 'input_services', 'capital_goods', 'ineligible'])
    .optional(),
  /** Why the credit is blocked — a section 17(5) reason, for the register. */
  itcIneligibleReason: nonEmpty.max(200).optional(),
  /**
   * Reverse charge: the supplier charged no tax and the business owes it
   * instead. The bill therefore carries no tax, while the line rates stay on
   * it — GSTR-3B reports the self-assessed liability and the matching credit
   * from those rates.
   */
  isReverseCharge: z.boolean().default(false),
  lines: z.array(purchaseLine).min(1).max(500),
  billDiscount: discount.optional(),
  /** Capitalised into stock cost per `landedCostBasis`. */
  freightAmount: paise.default(0),
  otherChargesAmount: paise.default(0),
  landedCostBasis: z.enum(['value', 'quantity', 'none']).default('value'),
  notes: nonEmpty.optional(),
  /** A saved T&C; its text is snapshotted onto the bill when issued. */
  termsId: z.string().uuid().nullable().optional(),
  receivedAt: timestamp,
  /** Payment made at the time of the bill, if any. */
  paidAmount: paise.default(0),
  paymentMode: z.enum(['cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque']).optional(),
});
export type CreatePurchaseBillBody = z.infer<typeof createPurchaseBillBody>;

export const listPurchaseBillsQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['issued', 'void']).optional(),
  supplierId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  unpaidOnly: booleanQuery.optional(),
});
export type ListPurchaseBillsQuery = z.infer<typeof listPurchaseBillsQuery>;

export const voidPurchaseBillBody = z.object({ reason: nonEmpty.max(200) });

// --- Supplier payments -----------------------------------------------------

export const createSupplierPaymentBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  supplierId: z.string().uuid(),
  mode: z.enum(['cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque']),
  amount: positivePaise,
  reference: nonEmpty.max(100).optional(),
  paidAt: timestamp,
  notes: nonEmpty.max(200).optional(),
  /**
   * Which bills this settles. Omitting it leaves the payment on account,
   * reducing the supplier's balance without being tied to a bill — which is
   * what an advance is.
   */
  allocations: z
    .array(z.object({ purchaseBillId: z.string().uuid(), amount: positivePaise }))
    .max(200)
    .optional(),
});
export type CreateSupplierPaymentBody = z.infer<typeof createSupplierPaymentBody>;

export const listSupplierPaymentsQuery = pageQuery.extend({
  supplierId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ListSupplierPaymentsQuery = z.infer<typeof listSupplierPaymentsQuery>;

export const voidSupplierPaymentBody = z.object({ reason: nonEmpty.max(200) });

// --- Purchase orders -------------------------------------------------------

export const createPurchaseOrderBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  supplierId: z.string().uuid(),
  documentDate: isoDate,
  expectedDate: isoDate.optional(),
  notes: nonEmpty.max(500).optional(),
  /** A saved T&C; its text is snapshotted onto the order when created. */
  termsId: z.string().uuid().nullable().optional(),
  lines: z
    .array(
      z.object({
        id: clientId,
        itemId: z.string().uuid(),
        itemName: nonEmpty.optional(),
        unit: nonEmpty.optional(),
        quantityOrdered: quantity,
        expectedUnitCost: paise.default(0),
      }),
    )
    .min(1)
    .max(500),
});
export type CreatePurchaseOrderBody = z.infer<typeof createPurchaseOrderBody>;

export const listPurchaseOrdersQuery = pageQuery.extend({
  supplierId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  status: z.enum(['draft', 'sent', 'partial', 'received', 'cancelled']).optional(),
  openOnly: booleanQuery.optional(),
});
export type ListPurchaseOrdersQuery = z.infer<typeof listPurchaseOrdersQuery>;

export const cancelPurchaseOrderBody = z.object({ reason: nonEmpty.max(200) });
