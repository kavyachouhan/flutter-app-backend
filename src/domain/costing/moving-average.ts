/**
 * Moving weighted average cost.
 *
 * The method Vyapar, Marg and most Indian retail software use, and the one
 * this system chose. It keeps a single cost per item per outlet rather than
 * FIFO layers, which is cheaper to maintain and matches how a shopkeeper
 * talks about cost — but it has two honest limitations, both encoded here
 * rather than hidden:
 *
 * - **A receipt cannot be exactly un-done.** Once goods have been sold at
 *   the blended rate, reversing the receipt cannot restore the prior average
 *   because the sales consumed a cost that no longer exists anywhere. The
 *   reversal below is the best available approximation and says so.
 * - **History is not re-costed.** A bill entered late moves the average from
 *   now on; it does not retroactively change the COGS already snapshotted
 *   onto earlier invoices. Re-costing history needs FIFO layers.
 *
 * Both are consequences of the method, not of this implementation. The
 * defence against them is that COGS is snapshotted onto the invoice line at
 * the moment of sale, so a report reads a historical fact rather than
 * recomputing from a cost that has since moved.
 */
import { QUANTITY_SCALE, roundHalfAwayFromZero } from '../../lib/money.js';

export interface CostState {
  /** Paise per whole unit. */
  readonly avgCost: number;
  /** Thousandths of a unit. May be negative where the shop oversold. */
  readonly quantityOnHand: number;
}

export interface Receipt {
  /** Thousandths received. Positive. */
  readonly quantity: number;
  /** Paise per whole unit, landed. */
  readonly unitCost: number;
}

/**
 * The new average after goods arrive.
 *
 * Negative stock is treated as zero for the weighting. Averaging against a
 * negative quantity produces a nonsense cost — with -10 on hand and 10
 * received the denominator is zero, and with -5 and 10 the prior cost gets
 * negative weight, which can drive the average below zero. A shop that
 * oversold has no stock to blend with, so the arriving cost simply becomes
 * the cost.
 */
export function applyReceipt(state: CostState, receipt: Receipt): CostState {
  if (receipt.quantity <= 0) return state;

  const held = Math.max(0, state.quantityOnHand);
  const newQuantity = state.quantityOnHand + receipt.quantity;

  if (held === 0) {
    return { avgCost: receipt.unitCost, quantityOnHand: newQuantity };
  }

  const heldValue = held * state.avgCost;
  const receivedValue = receipt.quantity * receipt.unitCost;
  const avgCost = roundHalfAwayFromZero((heldValue + receivedValue) / (held + receipt.quantity));

  return { avgCost, quantityOnHand: newQuantity };
}

/**
 * Backs a receipt out, for a voided purchase bill.
 *
 * Exact only when nothing has been sold since. Otherwise it is an
 * approximation: it removes the receipt's value and quantity from the pool
 * and re-derives an average, which is what a shopkeeper would expect to see,
 * but the figure cannot be reconciled to the pre-receipt average because the
 * intervening sales were costed at the blended rate.
 *
 * Reversing below zero stock, or out of an empty pool, keeps the current
 * average rather than inventing one.
 */
export function reverseReceipt(state: CostState, receipt: Receipt): CostState {
  if (receipt.quantity <= 0) return state;

  const newQuantity = state.quantityOnHand - receipt.quantity;
  const remaining = Math.max(0, newQuantity);

  if (remaining === 0) {
    // Nothing left to carry a cost. The average is held rather than zeroed,
    // so the next sale of oversold stock is not costed at nothing.
    return { avgCost: state.avgCost, quantityOnHand: newQuantity };
  }

  const pooledValue = Math.max(0, state.quantityOnHand) * state.avgCost;
  const removedValue = receipt.quantity * receipt.unitCost;
  const residual = pooledValue - removedValue;

  // A negative residual means the receipt was worth more than the pool now
  // holds, which happens when stock was sold after the receipt. Falling back
  // to the current average is wrong by less than a negative cost would be.
  if (residual <= 0) return { avgCost: state.avgCost, quantityOnHand: newQuantity };

  return { avgCost: roundHalfAwayFromZero(residual / remaining), quantityOnHand: newQuantity };
}

/** The cost of goods sold for a quantity, at the average in force right now. */
export function costOfGoodsSold(avgCost: number, quantity: number): number {
  return roundHalfAwayFromZero((avgCost * quantity) / QUANTITY_SCALE);
}
