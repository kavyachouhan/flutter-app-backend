/**
 * Inputs for the costing contract vectors: landed cost, moving-average cost, the cost of goods
 * sold, and a purchase bill's due date. A phone records a purchase bill offline and must arrive at
 * the figures the server will store, so each is run on both sides from these inputs.
 */
import type { ApportionInput, LandedCostBasis } from '../../src/domain/costing/landed-cost.js';
import type { CostState, Receipt } from '../../src/domain/costing/moving-average.js';
import { Rng } from './prng.js';

export type CostingContractCase =
  | { name: string; op: 'apportionLandedCost'; input: ApportionInput }
  | { name: string; op: 'applyReceipt'; input: { state: CostState; receipt: Receipt } }
  | { name: string; op: 'reverseReceipt'; input: { state: CostState; receipt: Receipt } }
  | { name: string; op: 'costOfGoodsSold'; input: { avgCost: number; quantity: number } }
  | { name: string; op: 'dueDateFor'; input: { documentDate: string; termsDays: number | null } };

const line = (quantity: number, taxableAmount: number, taxAmount = 0) => ({
  quantity,
  taxableAmount,
  taxAmount,
});

function handWritten(): CostingContractCase[] {
  const cases: CostingContractCase[] = [];

  // --- Landed cost -----------------------------------------------------------------------------
  const three = [line(2000, 10_000, 1800), line(1000, 20_000, 3600), line(3000, 30_000, 5400)];
  for (const basis of ['value', 'quantity', 'none'] as LandedCostBasis[]) {
    for (const itcEligible of [true, false]) {
      cases.push({
        name: `landed cost, ${basis}, ITC ${itcEligible ? 'claimed' : 'not claimed'}`,
        op: 'apportionLandedCost',
        input: { lines: three, additionalCost: 10_000, basis, itcEligible },
      });
    }
  }
  cases.push(
    {
      name: 'landed cost: no lines',
      op: 'apportionLandedCost',
      input: { lines: [], additionalCost: 500, basis: 'value', itcEligible: true },
    },
    {
      name: 'landed cost: freight that does not divide evenly sums exactly',
      op: 'apportionLandedCost',
      input: {
        lines: [line(1000, 10_000), line(1000, 10_000), line(1000, 10_000)],
        additionalCost: 10_000,
        basis: 'value',
        itcEligible: true,
      },
    },
    {
      name: 'landed cost: all weights zero spreads evenly',
      op: 'apportionLandedCost',
      input: {
        lines: [line(1000, 0), line(1000, 0)],
        additionalCost: 101,
        basis: 'value',
        itcEligible: true,
      },
    },
    {
      name: 'landed cost: a zero-quantity line takes no unit cost',
      op: 'apportionLandedCost',
      input: {
        lines: [line(0, 5_000, 900), line(2000, 5_000, 900)],
        additionalCost: 1_000,
        basis: 'quantity',
        itcEligible: false,
      },
    },
    {
      name: 'landed cost: unit cost rounds half away from zero',
      op: 'apportionLandedCost',
      input: {
        lines: [line(3000, 10_001)],
        additionalCost: 0,
        basis: 'value',
        itcEligible: true,
      },
    },
  );

  // --- Moving average --------------------------------------------------------------------------
  const receipt: Receipt = { quantity: 5000, unitCost: 4_000 };
  cases.push(
    {
      name: 'receipt blends with held stock',
      op: 'applyReceipt',
      input: { state: { avgCost: 3_000, quantityOnHand: 10_000 }, receipt },
    },
    {
      name: 'receipt into an empty pool takes the new cost',
      op: 'applyReceipt',
      input: { state: { avgCost: 3_000, quantityOnHand: 0 }, receipt },
    },
    {
      name: 'receipt over oversold stock is not blended against negative stock',
      op: 'applyReceipt',
      input: { state: { avgCost: 3_000, quantityOnHand: -5_000 }, receipt },
    },
    {
      name: 'a zero-quantity receipt changes nothing',
      op: 'applyReceipt',
      input: { state: { avgCost: 3_000, quantityOnHand: 10_000 }, receipt: { quantity: 0, unitCost: 1 } },
    },
    {
      name: 'receipt value above 2^53 uses double arithmetic like the server',
      op: 'applyReceipt',
      input: {
        state: { avgCost: 9_000_001, quantityOnHand: 2_000_000_003 },
        receipt: { quantity: 1_999_999_999, unitCost: 9_000_007 },
      },
    },
    {
      name: 'reversing a receipt removes its value and quantity',
      op: 'reverseReceipt',
      input: { state: { avgCost: 3_500, quantityOnHand: 15_000 }, receipt },
    },
    {
      name: 'reversing the whole pool keeps the average',
      op: 'reverseReceipt',
      input: { state: { avgCost: 3_500, quantityOnHand: 5_000 }, receipt },
    },
    {
      name: 'reversing when sales have eaten the receipt keeps the average',
      op: 'reverseReceipt',
      input: { state: { avgCost: 1_000, quantityOnHand: 6_000 }, receipt },
    },
    {
      name: 'reversing below zero stock keeps the average',
      op: 'reverseReceipt',
      input: { state: { avgCost: 3_500, quantityOnHand: 2_000 }, receipt },
    },
    {
      name: 'reversal above 2^53 uses double arithmetic like the server',
      op: 'reverseReceipt',
      input: {
        state: { avgCost: 9_000_001, quantityOnHand: 4_000_000_001 },
        receipt: { quantity: 1_999_999_999, unitCost: 9_000_007 },
      },
    },
    { name: 'cost of goods sold, whole units', op: 'costOfGoodsSold', input: { avgCost: 4_000, quantity: 3_000 } },
    { name: 'cost of goods sold rounds the paisa', op: 'costOfGoodsSold', input: { avgCost: 3_333, quantity: 1_500 } },
    { name: 'cost of goods sold at zero quantity', op: 'costOfGoodsSold', input: { avgCost: 3_333, quantity: 0 } },
  );

  // --- Due date --------------------------------------------------------------------------------
  const due = (documentDate: string, termsDays: number | null) =>
    ({
      name: `due date: ${documentDate} + ${termsDays === null ? 'no terms' : `${termsDays} days`}`,
      op: 'dueDateFor',
      input: { documentDate, termsDays },
    }) as const;
  cases.push(
    due('2026-10-27', null),
    due('2026-10-27', 0),
    due('2026-10-27', 30),
    due('2026-12-31', 1),
    due('2028-02-28', 1),
    due('2028-02-28', 2),
    due('2027-02-28', 1),
    due('2026-01-31', 30),
    due('2026-03-31', 365),
  );
  return cases;
}

const BASES: readonly LandedCostBasis[] = ['value', 'quantity', 'none'];

/** A seeded sweep, so every regeneration is byte-identical. */
function randomCases(): CostingContractCase[] {
  const rng = new Rng(20261102);
  const cases: CostingContractCase[] = [];

  for (let i = 0; i < 120; i++) {
    const count = rng.int(1, 6);
    const lines = Array.from({ length: count }, () =>
      line(rng.int(rng.chance(0.1) ? 0 : 1, 200_000), rng.int(0, 500_000), rng.int(0, 90_000)),
    );
    cases.push({
      name: `random landed cost #${i + 1}`,
      op: 'apportionLandedCost',
      input: {
        lines,
        additionalCost: rng.int(0, 60_000),
        basis: rng.pick(BASES),
        itcEligible: rng.chance(0.5),
      },
    });
  }

  for (let i = 0; i < 80; i++) {
    const state: CostState = {
      avgCost: rng.int(0, 2_000_000),
      quantityOnHand: rng.int(-20_000, 5_000_000),
    };
    const rec: Receipt = { quantity: rng.int(1, 5_000_000), unitCost: rng.int(0, 2_000_000) };
    cases.push({ name: `random receipt #${i + 1}`, op: 'applyReceipt', input: { state, receipt: rec } });
    cases.push({ name: `random reversal #${i + 1}`, op: 'reverseReceipt', input: { state, receipt: rec } });
  }

  for (let i = 0; i < 40; i++) {
    cases.push({
      name: `random cost of goods sold #${i + 1}`,
      op: 'costOfGoodsSold',
      input: { avgCost: rng.int(0, 5_000_000), quantity: rng.int(0, 5_000_000) },
    });
  }

  for (let i = 0; i < 30; i++) {
    const year = rng.int(2024, 2030);
    const month = String(rng.int(1, 12)).padStart(2, '0');
    const day = String(rng.int(1, 28)).padStart(2, '0');
    cases.push({
      name: `random due date #${i + 1}`,
      op: 'dueDateFor',
      input: { documentDate: `${year}-${month}-${day}`, termsDays: rng.chance(0.15) ? null : rng.int(0, 400) },
    });
  }
  return cases;
}

export function costingCases(): CostingContractCase[] {
  return [...handWritten(), ...randomCases()];
}
