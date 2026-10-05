import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { isoDate, nonEmpty, paise, quantity, timestamp } from '../../lib/validators.js';

export const PRICE_LIST_KINDS = ['retail', 'wholesale', 'distributor', 'custom'] as const;
export const PRICE_LIST_BASES = ['fixed', 'percent_off_sale', 'percent_on_cost'] as const;

const percent = z.number().min(0).max(100);

const priceListFields = {
  name: nonEmpty.max(80),
  kind: z.enum(PRICE_LIST_KINDS),
  /**
   * How an item with no explicit price on this list is priced. `fixed` means
   * only the explicit prices apply and anything else falls through to the
   * item's own selling price — a list is a set of overrides, not a whitelist.
   */
  basis: z.enum(PRICE_LIST_BASES).default('fixed'),
  basisValue: percent.default(0),
  /** Paise. The list may never price below this, whatever the basis computes. */
  minPriceFloor: paise.nullable().optional(),
  isDefault: z.boolean().optional(),
  effectiveFrom: isoDate.nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
  isActive: z.boolean().optional(),
};

export const createPriceListBody = z
  .object({ id: clientId, ...priceListFields })
  .refine((l) => l.basis === 'fixed' || l.basisValue > 0, {
    message: 'a percentage basis needs a basisValue above zero',
    path: ['basisValue'],
  });
export type CreatePriceListBody = z.infer<typeof createPriceListBody>;

export const updatePriceListBody = z.object(priceListFields).partial();
export type UpdatePriceListBody = z.infer<typeof updatePriceListBody>;

export const listPriceListsQuery = pageQuery.extend({
  kind: z.enum(PRICE_LIST_KINDS).optional(),
  includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type ListPriceListsQuery = z.infer<typeof listPriceListsQuery>;

/**
 * A whole-list upsert of item prices. Capped at 1000 because this is the
 * interactive path; repricing a larger catalogue is a revision job, which
 * previews what it will do and applies in chunks.
 */
export const putPriceListItemsBody = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        /** Thousandths. The price applies from this quantity up. */
        minQuantity: quantity.or(z.literal(0)).default(0),
        unitPrice: paise,
        pricesIncludeTax: z.boolean(),
      }),
    )
    .min(1)
    .max(1000),
  /** True replaces every price on the list; false merges these in. */
  replace: z.boolean().default(false),
});
export type PutPriceListItemsBody = z.infer<typeof putPriceListItemsBody>;

export const resolvePriceQuery = z.object({
  itemId: z.string().uuid(),
  /** Absent for a walk-in, who takes the default list. */
  customerId: z.string().uuid().optional(),
  /** Overrides the customer's list, for a quote at a named list. */
  priceListId: z.string().uuid().optional(),
  quantity: z.coerce.number().int().positive().default(1000),
  outletId: z.string().uuid().optional(),
});
export type ResolvePriceQuery = z.infer<typeof resolvePriceQuery>;

// --- Discount policy -------------------------------------------------------

/**
 * Every limit is nullable, and null means "no limit" rather than zero — a cap
 * of zero is a shop that forbids discounts outright, which is a different and
 * legitimate setting.
 */
export const putDiscountPolicyBody = z.object({
  /** Null sets the tenant-wide policy; an id sets that outlet's override. */
  outletId: z.string().uuid().nullable().optional(),
  maxLineDiscountPercent: percent.nullable().optional(),
  maxBillDiscountPercent: percent.nullable().optional(),
  maxDiscountAmount: paise.nullable().optional(),
  minMarginPercent: z.number().min(0).nullable().optional(),
  requireApprovalAbovePercent: percent.nullable().optional(),
  approverPermission: nonEmpty.optional(),
});
export type PutDiscountPolicyBody = z.infer<typeof putDiscountPolicyBody>;

export const BREACH_KINDS = [
  'line_discount_percent',
  'bill_discount_percent',
  'discount_amount',
  'min_margin',
] as const;

/**
 * An approval as it travels inside the invoice that carries the discount.
 *
 * There is no endpoint that posts one on its own: it is part of the document,
 * like a tender or a line, so the discount and the authority for it commit
 * together and an offline sale uploads its evidence with it.
 *
 * `breachKind` and the two values are what the till's own copy of the pure cap
 * check produced. The server re-runs that check and compares, so a fabricated
 * approval for a discount that was never over the cap is visible.
 */
export const discountApproval = z.object({
  id: clientId,
  /** The line it was given on; omitted for a bill-level discount. */
  invoiceLineId: z.string().uuid().optional(),
  breachKind: z.enum(BREACH_KINDS),
  requestedValue: z.number(),
  allowedValue: z.number(),
  /** Who authorised it. Checked against the policy's approver permission. */
  approvedBy: z.string().uuid(),
  reason: nonEmpty.max(280).optional(),
  approvedAt: timestamp,
});
export type DiscountApprovalInput = z.infer<typeof discountApproval>;

export const listDiscountApprovalsQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  approvedBy: z.string().uuid().optional(),
  invoiceId: z.string().uuid().optional(),
});
export type ListDiscountApprovalsQuery = z.infer<typeof listDiscountApprovalsQuery>;

// --- Bulk price revision ---------------------------------------------------

export const REVISION_OPERATIONS = [
  'percent_increase',
  'percent_decrease',
  'amount_increase',
  'amount_decrease',
  'set_from_cost',
] as const;

export const createPriceRevisionBody = z
  .object({
    id: clientId,
    target: z.enum(['item_sale_price', 'price_list']),
    priceListId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    operation: z.enum(REVISION_OPERATIONS),
    /** Percent for the percentage operations, paise for the amount ones. */
    operationValue: z.number().nonnegative(),
    /** Round each new price to a multiple of this many paise. */
    roundToPaise: z.number().int().positive().optional(),
    effectiveFrom: isoDate.optional(),
  })
  .refine((b) => b.target === 'item_sale_price' || b.priceListId !== undefined, {
    message: 'repricing a list needs priceListId',
    path: ['priceListId'],
  });
export type CreatePriceRevisionBody = z.infer<typeof createPriceRevisionBody>;

export const listPriceRevisionsQuery = pageQuery.extend({
  status: z
    .enum(['pending', 'analysing', 'analysed', 'applying', 'applied', 'failed', 'cancelled'])
    .optional(),
});
export type ListPriceRevisionsQuery = z.infer<typeof listPriceRevisionsQuery>;

export const listRevisionRowsQuery = pageQuery.extend({
  action: z.enum(['pending', 'change', 'skip', 'error']).optional(),
});
export type ListRevisionRowsQuery = z.infer<typeof listRevisionRowsQuery>;
