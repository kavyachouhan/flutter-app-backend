/**
 * Price resolution and discount caps. Pure — no clock, I/O or randomness —
 * because the till has to answer both questions with no network: what this
 * customer pays for this item, and whether the cashier may give this discount.
 *
 * The server runs the same two functions. It does not *impose* the answer: a
 * sale uploaded hours later already happened, and the device was right about
 * the price at the time even if the price list has moved since. So the server
 * re-derives in order to say what it would have charged, and reports a
 * difference rather than rejecting one. The only thing that makes that safe is
 * both sides running identical code, which is why this file is pure and
 * mirrored in Dart exactly as the tax engine and the numbering series are.
 *
 * Money is integer paise; quantities are thousandths of a unit; percentages
 * are decimals. Rounding is half away from zero, as everywhere else.
 */
import { percentOf, roundHalfAwayFromZero } from '../../lib/money.js';

/** How a price list derives a price when it holds no explicit one for an item. */
export type PriceListBasis =
  /** Only the explicit per-item prices apply; anything else falls through. */
  | 'fixed'
  /** A percentage off the item's own selling price. Wholesale, usually. */
  | 'percent_off_sale'
  /** A percentage added to moving-average cost. Protects margin as cost moves. */
  | 'percent_on_cost';

export interface PriceList {
  readonly id: string;
  readonly basis: PriceListBasis;
  /** Percent, read according to `basis`. Ignored when the basis is `fixed`. */
  readonly basisValue: number;
  /**
   * Floor in paise below which this list may never price, whatever the basis
   * computes. A cost-plus list with a stale cost is how a shop sells below
   * what it paid without anyone noticing.
   */
  readonly minPriceFloor?: number | undefined;
}

/** An explicit price for one item on one list, optionally above a break quantity. */
export interface PriceListEntry {
  readonly unitPrice: number;
  /**
   * Thousandths. The entry applies from this quantity up; entries for the same
   * item form a quantity-break ladder.
   */
  readonly minQuantity: number;
  /**
   * Whether `unitPrice` already includes tax. Independent of the item's own
   * flag and of the invoice's: a wholesale list is usually quoted exclusive
   * even in a shop that prices retail inclusive.
   */
  readonly pricesIncludeTax: boolean;
}

export interface PricedItem {
  readonly salePrice: number;
  readonly pricesIncludeTax: boolean;
  /** Moving-average cost in paise, or undefined when never purchased. */
  readonly averageCost?: number | undefined;
}

export interface PriceResolutionInput {
  readonly item: PricedItem;
  /** Thousandths of a unit being sold, which selects the quantity break. */
  readonly quantity: number;
  /** Absent for a walk-in, or a customer on no particular list. */
  readonly priceList?: PriceList | undefined;
  /** Every entry the list holds for this item, in any order. */
  readonly entries?: readonly PriceListEntry[] | undefined;
}

/** Where a resolved price came from, so the invoice line can record why. */
export type PriceSource =
  /** An explicit per-item price on the list. */
  | 'price_list_item'
  /** The list's basis applied to the item. */
  | 'price_list_rule'
  /** The item's own selling price; no list applied. */
  | 'item';

export interface ResolvedPrice {
  readonly unitPrice: number;
  readonly pricesIncludeTax: boolean;
  readonly source: PriceSource;
  readonly priceListId: string | undefined;
  /** True when a floor overrode what the basis computed. */
  readonly flooredToMinimum: boolean;
}

/**
 * The price for one item for one customer at one quantity.
 *
 * Resolution order, most specific first:
 *   1. an explicit entry on the customer's list, taking the highest quantity
 *      break at or below what is being sold
 *   2. the list's own rule, if it has one
 *   3. the item's selling price
 *
 * A list with no entry and a `fixed` basis therefore falls through to the item
 * rather than pricing at zero — a list is a set of overrides, not a whitelist,
 * and a wholesale customer buying something nobody has priced for wholesale
 * should still be billable.
 */
export function resolvePrice(input: PriceResolutionInput): ResolvedPrice {
  const { item, priceList } = input;

  const entry = bestEntryFor(input.entries, input.quantity);
  if (entry) {
    return {
      unitPrice: entry.unitPrice,
      pricesIncludeTax: entry.pricesIncludeTax,
      source: 'price_list_item',
      priceListId: priceList?.id,
      flooredToMinimum: false,
    };
  }

  if (priceList && priceList.basis !== 'fixed') {
    const derived = applyBasis(priceList, item);
    if (derived !== undefined) {
      const floor = priceList.minPriceFloor;
      const floored = floor !== undefined && derived < floor;
      return {
        unitPrice: floored ? floor : derived,
        // A derived price inherits the item's convention: it is computed from
        // the item's own figures, so it is quoted the same way they are.
        pricesIncludeTax: item.pricesIncludeTax,
        source: 'price_list_rule',
        priceListId: priceList.id,
        flooredToMinimum: floored,
      };
    }
  }

  return {
    unitPrice: item.salePrice,
    pricesIncludeTax: item.pricesIncludeTax,
    source: 'item',
    priceListId: undefined,
    flooredToMinimum: false,
  };
}

/**
 * The entry for the largest quantity break at or below `quantity`.
 *
 * Ties go to the higher price, which is the conservative reading: two entries
 * at the same break is a data error, and under-charging on it is the outcome
 * that costs the shop money silently.
 */
function bestEntryFor(
  entries: readonly PriceListEntry[] | undefined,
  quantity: number,
): PriceListEntry | undefined {
  if (!entries || entries.length === 0) return undefined;
  let best: PriceListEntry | undefined;
  for (const entry of entries) {
    if (entry.minQuantity > quantity) continue;
    if (
      !best ||
      entry.minQuantity > best.minQuantity ||
      (entry.minQuantity === best.minQuantity && entry.unitPrice > best.unitPrice)
    ) {
      best = entry;
    }
  }
  return best;
}

/** Undefined when the basis cannot be applied — cost-plus with no cost known. */
function applyBasis(priceList: PriceList, item: PricedItem): number | undefined {
  if (priceList.basis === 'percent_off_sale') {
    const off = percentOf(item.salePrice, priceList.basisValue);
    return Math.max(0, item.salePrice - off);
  }
  // percent_on_cost. An item never purchased through the system has no
  // average cost, and marking up zero would price it at zero — so the rule
  // does not apply and the caller falls through to the selling price.
  if (item.averageCost === undefined || item.averageCost <= 0) return undefined;
  return item.averageCost + percentOf(item.averageCost, priceList.basisValue);
}

// --- Discount caps ---------------------------------------------------------

/**
 * The effective policy at a till, already merged from the tenant-wide row and
 * any outlet override. Every field is optional because an unset limit means
 * "no limit", not zero.
 */
export interface DiscountPolicy {
  readonly maxLineDiscountPercent?: number | undefined;
  readonly maxBillDiscountPercent?: number | undefined;
  /** Paise. A ceiling on the whole document's discount, however it was given. */
  readonly maxDiscountAmount?: number | undefined;
  /**
   * Percent of the selling price that must survive as margin over cost. The
   * one limit that catches a discount which is within every percentage cap and
   * still loses money.
   */
  readonly minMarginPercent?: number | undefined;
  /**
   * Percent above which a discount needs someone's approval rather than being
   * refused. Below the cap and above this, the till asks.
   */
  readonly requireApprovalAbovePercent?: number | undefined;
}

export type CapKind =
  | 'line_discount_percent'
  | 'bill_discount_percent'
  | 'discount_amount'
  | 'min_margin';

export interface CapBreach {
  readonly kind: CapKind;
  /** The line it was found on, or undefined for a document-level breach. */
  readonly lineId: string | undefined;
  /** What was given, as a percent for percentage caps and paise for amounts. */
  readonly actual: number;
  /** What the policy allows, in the same unit as `actual`. */
  readonly allowed: number;
  /** True when an approval would satisfy the policy rather than a refusal. */
  readonly approvable: boolean;
}

/** One line as it ends up on the document, which is what a cap is measured against. */
export interface DiscountedLine {
  readonly id: string;
  /** Before any discount. */
  readonly grossAmount: number;
  /** This line's own discount, in paise. */
  readonly lineDiscount: number;
  /** This line's share of the bill discount, in paise. */
  readonly billDiscountShare: number;
  /** Moving-average cost of the quantity on this line, when known. */
  readonly costAmount?: number | undefined;
}

export interface DiscountCapInput {
  readonly policy: DiscountPolicy;
  readonly lines: readonly DiscountedLine[];
  /** Document-level discount in paise, as the tax engine resolved it. */
  readonly billDiscount: number;
  /** Sum of line gross amounts, which the bill discount percentage is of. */
  readonly grossAmount: number;
}

/**
 * Every way the discounts on a document exceed what the policy allows.
 *
 * Returns all breaches rather than the first, because the till has to tell the
 * cashier what to fix and "something is over the limit" is not that. An empty
 * array means the document is within policy.
 *
 * Percentages are measured against gross, not against the post-discount
 * figure: a 50% cap has to mean half off the ticket price, which is what a
 * cashier and an owner both read it as.
 */
export function capBreaches(input: DiscountCapInput): CapBreach[] {
  const { policy } = input;
  const breaches: CapBreach[] = [];

  for (const line of input.lines) {
    if (policy.maxLineDiscountPercent !== undefined && line.grossAmount > 0) {
      const actual = percentageOf(line.lineDiscount, line.grossAmount);
      if (actual > policy.maxLineDiscountPercent) {
        breaches.push({
          kind: 'line_discount_percent',
          lineId: line.id,
          actual,
          allowed: policy.maxLineDiscountPercent,
          approvable: isApprovable(policy, actual),
        });
      }
    }

    // Margin is checked against the total discount the line actually bears,
    // its own plus its share of the bill's, because that is what the shop
    // gave away on it.
    if (policy.minMarginPercent !== undefined && line.costAmount !== undefined) {
      const net = line.grossAmount - line.lineDiscount - line.billDiscountShare;
      const required = line.costAmount + percentOf(line.costAmount, policy.minMarginPercent);
      if (net < required) {
        breaches.push({
          kind: 'min_margin',
          lineId: line.id,
          actual: net,
          allowed: required,
          // Margin is the one limit worth asking about rather than enforcing:
          // clearing old stock below margin is a legitimate decision, and it
          // is the owner's to make, not the cashier's.
          approvable: true,
        });
      }
    }
  }

  if (policy.maxBillDiscountPercent !== undefined && input.grossAmount > 0) {
    const actual = percentageOf(input.billDiscount, input.grossAmount);
    if (actual > policy.maxBillDiscountPercent) {
      breaches.push({
        kind: 'bill_discount_percent',
        lineId: undefined,
        actual,
        allowed: policy.maxBillDiscountPercent,
        approvable: isApprovable(policy, actual),
      });
    }
  }

  if (policy.maxDiscountAmount !== undefined) {
    const total =
      input.billDiscount + input.lines.reduce((sum, line) => sum + line.lineDiscount, 0);
    if (total > policy.maxDiscountAmount) {
      breaches.push({
        kind: 'discount_amount',
        lineId: undefined,
        actual: total,
        allowed: policy.maxDiscountAmount,
        approvable: true,
      });
    }
  }

  return breaches;
}

/**
 * A breach is approvable when the policy names an approval threshold at all
 * and the discount is not so far past the cap that no approval was intended
 * to cover it. Without a threshold the cap is absolute: the owner set a limit
 * and said nothing about anyone overriding it.
 */
function isApprovable(policy: DiscountPolicy, actual: number): boolean {
  if (policy.requireApprovalAbovePercent === undefined) return false;
  return actual >= policy.requireApprovalAbovePercent;
}

/** Percent of `base` that `part` represents, to two decimal places. */
function percentageOf(part: number, base: number): number {
  if (base <= 0) return 0;
  return roundHalfAwayFromZero((part * 10_000) / base) / 100;
}

/**
 * Merges an outlet's policy over the tenant-wide one field by field, where a
 * null or undefined field on the outlet row means "inherit".
 *
 * The same shape as the print-profile merge, and for the same reason: a shop
 * sets a policy once and a single branch overrides one number of it, rather
 * than restating the whole policy per outlet and drifting.
 */
export function mergeDiscountPolicy(
  tenantWide: Partial<DiscountPolicy> | undefined,
  outlet: Partial<DiscountPolicy> | undefined,
): DiscountPolicy {
  const pick = <K extends keyof DiscountPolicy>(key: K): DiscountPolicy[K] =>
    outlet?.[key] ?? tenantWide?.[key];
  return {
    maxLineDiscountPercent: pick('maxLineDiscountPercent'),
    maxBillDiscountPercent: pick('maxBillDiscountPercent'),
    maxDiscountAmount: pick('maxDiscountAmount'),
    minMarginPercent: pick('minMarginPercent'),
    requireApprovalAbovePercent: pick('requireApprovalAbovePercent'),
  };
}
