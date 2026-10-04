/**
 * Landed cost: what a purchased unit actually costs once freight is on it.
 *
 * Two rules here, and both have a wrong answer that looks right.
 *
 * **Apportionment.** Freight is a bill-level amount that has to become a
 * per-line one. Splitting by value suits mixed goods; splitting by quantity
 * suits homogeneous bulk where the lorry charges by volume. Either way the
 * shares must sum to exactly the freight, which is why `distribute` from
 * lib/money.ts does the arithmetic — rounding each share independently loses
 * paise and leaves stock valued at a number that does not reconcile.
 *
 * **Recoverable tax.** A registered dealer reclaims the GST on a purchase as
 * input tax credit, so that tax is not a cost and must not be capitalised
 * into stock. Capitalising it overstates COGS and understates margin on
 * every subsequent sale. For a composition or unregistered dealer the tax is
 * never reclaimed, so it *is* part of the cost. This is the one piece of
 * genuine accounting in the module and the easiest thing to get backwards.
 */
import { distribute, QUANTITY_SCALE, roundHalfAwayFromZero } from '../../lib/money.js';

export type LandedCostBasis = 'value' | 'quantity' | 'none';

export interface CostableLine {
  /** Thousandths of a unit. Must be positive. */
  readonly quantity: number;
  /** Paise, after discounts and before tax. */
  readonly taxableAmount: number;
  /** Paise of GST and cess charged by the supplier on this line. */
  readonly taxAmount: number;
}

export interface CostedLine {
  readonly landedCostShare: number;
  /** Paise per whole unit, which is what `item_costs.avg_cost` stores. */
  readonly effectiveUnitCost: number;
  /** Paise: the whole line's cost, kept so the caller need not re-multiply. */
  readonly lineCost: number;
}

export interface ApportionInput {
  readonly lines: readonly CostableLine[];
  /** Freight plus any other bill-level charge being capitalised. Paise. */
  readonly additionalCost: number;
  readonly basis: LandedCostBasis;
  /**
   * True when the business reclaims the GST on this bill. The tax is then
   * excluded from cost; otherwise it is part of it.
   */
  readonly itcEligible: boolean;
}

/**
 * Splits `additionalCost` across the lines and returns each line's cost.
 *
 * A line with zero quantity would divide by zero on the way to a unit cost,
 * so it takes no share and costs nothing — the caller rejects such a line
 * before it reaches here, and this is the belt to that braces.
 */
export function apportionLandedCost(input: ApportionInput): CostedLine[] {
  const { lines, basis, itcEligible } = input;
  if (lines.length === 0) return [];

  const additionalCost = basis === 'none' ? 0 : input.additionalCost;
  const weights = lines.map((line) =>
    basis === 'quantity' ? Math.max(0, line.quantity) : Math.max(0, line.taxableAmount),
  );

  // All weights zero — a bill of free samples with freight on it — would
  // make the split undefined. `distribute` spreads evenly in that case,
  // which is the only defensible answer.
  const shares = distribute(additionalCost, weights);

  return lines.map((line, index) => {
    const share = shares[index] ?? 0;
    // Non-recoverable tax is part of what the shop paid and never comes back.
    const taxInCost = itcEligible ? 0 : line.taxAmount;
    const lineCost = line.taxableAmount + taxInCost + share;

    return {
      landedCostShare: share,
      effectiveUnitCost:
        line.quantity > 0 ? roundHalfAwayFromZero((lineCost * QUANTITY_SCALE) / line.quantity) : 0,
      lineCost,
    };
  });
}
