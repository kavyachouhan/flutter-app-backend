import { describe, expect, it } from 'vitest';
import { apportionLandedCost, type CostableLine } from './landed-cost.js';
import { applyReceipt, costOfGoodsSold, reverseReceipt } from './moving-average.js';

const line = (taxableAmount: number, quantity: number, taxAmount = 0): CostableLine => ({
  taxableAmount,
  quantity,
  taxAmount,
});

describe('apportionLandedCost', () => {
  it('splits freight by value', () => {
    const costed = apportionLandedCost({
      lines: [line(60_000, 1000), line(40_000, 1000)],
      additionalCost: 1000,
      basis: 'value',
      itcEligible: true,
    });
    expect(costed.map((c) => c.landedCostShare)).toEqual([600, 400]);
  });

  it('splits freight by quantity when the goods are homogeneous', () => {
    const costed = apportionLandedCost({
      lines: [line(60_000, 1000), line(40_000, 3000)],
      additionalCost: 1000,
      basis: 'quantity',
      itcEligible: true,
    });
    expect(costed.map((c) => c.landedCostShare)).toEqual([250, 750]);
  });

  it('never loses a paisa to rounding', () => {
    // ₹10 across three equal lines cannot divide evenly; the shares must
    // still sum to exactly 1000, or stock value stops reconciling.
    const costed = apportionLandedCost({
      lines: [line(100, 1000), line(100, 1000), line(100, 1000)],
      additionalCost: 1000,
      basis: 'value',
      itcEligible: true,
    });
    expect(costed.reduce((t, c) => t + c.landedCostShare, 0)).toBe(1000);
  });

  it('capitalises nothing when the basis is none', () => {
    const costed = apportionLandedCost({
      lines: [line(10_000, 1000)],
      additionalCost: 5000,
      basis: 'none',
      itcEligible: true,
    });
    expect(costed[0]?.landedCostShare).toBe(0);
    expect(costed[0]?.effectiveUnitCost).toBe(10_000);
  });

  it('excludes reclaimable GST from cost', () => {
    // A registered dealer gets the ₹18 back as input tax credit, so stock
    // cost is the ₹100 taxable value, not ₹118.
    const costed = apportionLandedCost({
      lines: [line(10_000, 1000, 1800)],
      additionalCost: 0,
      basis: 'value',
      itcEligible: true,
    });
    expect(costed[0]?.effectiveUnitCost).toBe(10_000);
  });

  it('includes GST in cost when it cannot be reclaimed', () => {
    // A composition or unregistered dealer never gets it back, so ₹118 is
    // genuinely what the unit cost.
    const costed = apportionLandedCost({
      lines: [line(10_000, 1000, 1800)],
      additionalCost: 0,
      basis: 'value',
      itcEligible: false,
    });
    expect(costed[0]?.effectiveUnitCost).toBe(11_800);
  });

  it('prices per unit, not per line', () => {
    // ₹500 for 5 units plus ₹50 freight = ₹110 a unit.
    const costed = apportionLandedCost({
      lines: [line(50_000, 5000)],
      additionalCost: 5000,
      basis: 'value',
      itcEligible: true,
    });
    expect(costed[0]?.effectiveUnitCost).toBe(11_000);
  });

  it('spreads evenly when every weight is zero', () => {
    const costed = apportionLandedCost({
      lines: [line(0, 1000), line(0, 1000)],
      additionalCost: 1000,
      basis: 'value',
      itcEligible: true,
    });
    expect(costed.map((c) => c.landedCostShare)).toEqual([500, 500]);
  });
});

describe('applyReceipt', () => {
  it('blends the old and new cost by quantity', () => {
    // 10 @ ₹100 then 10 @ ₹120 averages ₹110.
    const next = applyReceipt(
      { avgCost: 10_000, quantityOnHand: 10_000 },
      { quantity: 10_000, unitCost: 12_000 },
    );
    expect(next).toEqual({ avgCost: 11_000, quantityOnHand: 20_000 });
  });

  it('weights by quantity, not by number of receipts', () => {
    // 30 @ ₹100 then 10 @ ₹140 is ₹110, not ₹120.
    const next = applyReceipt(
      { avgCost: 10_000, quantityOnHand: 30_000 },
      { quantity: 10_000, unitCost: 14_000 },
    );
    expect(next.avgCost).toBe(11_000);
  });

  it('takes the arriving cost when there is no stock', () => {
    const next = applyReceipt(
      { avgCost: 0, quantityOnHand: 0 },
      { quantity: 5000, unitCost: 9900 },
    );
    expect(next).toEqual({ avgCost: 9900, quantityOnHand: 5000 });
  });

  it('does not blend against oversold stock', () => {
    // With -10 on hand, weighting by the signed quantity would divide by
    // zero here and could drive the average negative in other shapes. The
    // shop has nothing to blend with, so the arriving cost is the cost.
    const next = applyReceipt(
      { avgCost: 10_000, quantityOnHand: -10_000 },
      { quantity: 10_000, unitCost: 12_000 },
    );
    expect(next).toEqual({ avgCost: 12_000, quantityOnHand: 0 });
  });

  it('ignores a receipt of nothing', () => {
    const state = { avgCost: 10_000, quantityOnHand: 1000 };
    expect(applyReceipt(state, { quantity: 0, unitCost: 5000 })).toBe(state);
  });

  it('halves the cost if the arriving goods are already counted on hand', () => {
    // Not a feature — a guard on the caller. The purchase service seeds a
    // missing item_costs row from stock_balances, so it must apply the
    // receipt BEFORE writing the stock entries. If it does not, the state
    // below is what applyReceipt is handed: the goods already in the pool,
    // held at zero. The result is silently half the real cost, which is
    // exactly the kind of error nobody notices until margins look wrong.
    const alreadyCounted = applyReceipt(
      { avgCost: 0, quantityOnHand: 10_000 },
      { quantity: 10_000, unitCost: 12_000 },
    );
    expect(alreadyCounted.avgCost).toBe(6000);

    // Applied in the right order, against an empty pool, the cost is right.
    const correct = applyReceipt(
      { avgCost: 0, quantityOnHand: 0 },
      { quantity: 10_000, unitCost: 12_000 },
    );
    expect(correct.avgCost).toBe(12_000);
  });
});

describe('reverseReceipt', () => {
  it('restores the previous average exactly when nothing was sold', () => {
    const before = { avgCost: 10_000, quantityOnHand: 10_000 };
    const after = applyReceipt(before, { quantity: 10_000, unitCost: 12_000 });
    expect(reverseReceipt(after, { quantity: 10_000, unitCost: 12_000 })).toEqual(before);
  });

  it('keeps the average rather than zeroing it when the pool empties', () => {
    // Costing the next sale of oversold stock at nothing would report
    // infinite margin.
    const after = reverseReceipt(
      { avgCost: 11_000, quantityOnHand: 10_000 },
      { quantity: 10_000, unitCost: 12_000 },
    );
    expect(after).toEqual({ avgCost: 11_000, quantityOnHand: 0 });
  });

  it('refuses to produce a negative cost when stock was sold after the receipt', () => {
    // The approximation this method cannot avoid: the intervening sales
    // consumed value at the blended rate, so the residual does not reconcile.
    // Holding the current average beats reporting a negative one.
    const after = reverseReceipt(
      { avgCost: 11_000, quantityOnHand: 2000 },
      { quantity: 1000, unitCost: 90_000 },
    );
    expect(after.avgCost).toBe(11_000);
    expect(after.quantityOnHand).toBe(1000);
  });
});

describe('costOfGoodsSold', () => {
  it('scales by thousandths', () => {
    expect(costOfGoodsSold(11_000, 2500)).toBe(27_500);
  });

  it('rounds half away from zero, like the tax engine', () => {
    expect(costOfGoodsSold(1, 1500)).toBe(2);
  });
});
