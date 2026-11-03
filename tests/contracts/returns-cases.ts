/**
 * Inputs for the returns contract vectors: how "return N units of invoice line L" becomes tax
 * engine input. A phone issues credit notes offline and the server must reach the same totals, so
 * the derivation — above all the supply category and the scaling of discounts — is run on both
 * sides from these inputs.
 */
import type { ReturnRequest, SoldLine } from '../../src/domain/tax/returns.js';
import type { SupplyCategory } from '../../src/domain/tax/types.js';
import { Rng } from './prng.js';

export interface ReturnsContractCase {
  readonly name: string;
  readonly op: 'deriveReturnLine';
  readonly input: { readonly sold: SoldLine; readonly request: ReturnRequest };
}

const sold = (over: Partial<SoldLine> = {}): SoldLine => ({
  id: 'l1',
  quantity: 3000,
  unitPrice: 10_000,
  lineDiscount: 0,
  billDiscountShare: 0,
  taxRatePercent: 18,
  cessRatePercent: 0,
  hsnCode: '1006',
  supplyCategory: 'taxable',
  ...over,
});

const ask = (quantity: number): ReturnRequest => ({ id: 'r1', invoiceLineId: 'l1', quantity });

function handWritten(): ReturnsContractCase[] {
  const c = (name: string, s: SoldLine, q: number): ReturnsContractCase => ({
    name,
    op: 'deriveReturnLine',
    input: { sold: s, request: ask(q) },
  });
  return [
    c('return the whole line', sold(), 3000),
    c('return part of a line with no discount', sold(), 1000),
    c('return part of a discounted line scales the discount', sold({ lineDiscount: 1000 }), 1000),
    c(
      'bill discount share is scaled with the line discount',
      sold({ lineDiscount: 500, billDiscountShare: 333 }),
      1000,
    ),
    c('scaled discount that lands on .5 rounds away from zero', sold({ lineDiscount: 5, quantity: 2000 }), 1000),
    c('whole return keeps the full discount exactly', sold({ lineDiscount: 777, billDiscountShare: 111 }), 3000),
    ...(['exempt', 'nil_rated', 'non_gst'] as SupplyCategory[]).map((category) =>
      c(`a ${category} line stays ${category} on the return`, sold({ supplyCategory: category, taxRatePercent: 0 }), 1000),
    ),
    c('a sale with no HSN code returns with none', sold({ hsnCode: null }), 1000),
    c('cess is carried over', sold({ cessRatePercent: 12 }), 1500),
    c('fractional quantities are thousandths', sold({ quantity: 2500 }), 1250),
    c('more than was sold is refused', sold(), 3001),
    c('zero is refused', sold(), 0),
    c('a negative quantity is refused', sold(), -1),
  ];
}

function randomCases(): ReturnsContractCase[] {
  const rng = new Rng(20261103);
  const categories: SupplyCategory[] = ['taxable', 'exempt', 'nil_rated', 'non_gst'];
  const cases: ReturnsContractCase[] = [];
  for (let i = 0; i < 150; i++) {
    const quantity = rng.int(1, 500_000);
    const s = sold({
      quantity,
      unitPrice: rng.int(1, 5_000_000),
      lineDiscount: rng.chance(0.5) ? rng.int(0, 200_000) : 0,
      billDiscountShare: rng.chance(0.4) ? rng.int(0, 50_000) : 0,
      taxRatePercent: rng.pick([0, 5, 12, 18, 28]),
      cessRatePercent: rng.chance(0.2) ? rng.int(1, 20) : 0,
      hsnCode: rng.chance(0.8) ? String(rng.int(1000, 99999999)) : null,
      supplyCategory: rng.pick(categories),
    });
    cases.push({
      name: `random return #${i + 1}`,
      op: 'deriveReturnLine',
      input: { sold: s, request: ask(rng.int(1, quantity)) },
    });
  }
  return cases;
}

export function returnsCases(): ReturnsContractCase[] {
  return [...handWritten(), ...randomCases()];
}
