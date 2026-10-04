/**
 * Inputs for the tax-engine contract vectors.
 *
 * Two groups: hand-written cases that pin each rule of the engine by name,
 * and seeded pseudo-random cases that sweep the input space (fractional
 * percentages, tax-inclusive back-calculation, apportionment ties, cess,
 * round-off in both directions). The Dart port must reproduce every expected
 * output exactly; the random group is where floating-point divergence shows.
 */
import type {
  AdditionalCharge,
  Discount,
  TaxInvoiceInput,
  TaxLineInput,
} from '../../src/domain/tax/types.js';
import { Rng } from './prng.js';

/** The rules the vectors were generated under; the consumer must use the same set. */
export const CONTRACT_GST_RATES: readonly number[] = [0, 0.25, 3, 5, 12, 18, 28, 40];

export interface TaxContractCase {
  readonly name: string;
  readonly input: TaxInvoiceInput;
}

const RANDOM_SEED = 20260917;
// 300 keeps the file near 1.5 MB. Coverage of the arithmetic paths is already
// dense at this size; more cases only make the Dart parity test slower.
const RANDOM_CASE_COUNT = 300;

function line(overrides: Partial<TaxLineInput> = {}): TaxLineInput {
  return { id: 'l1', quantity: 1000, unitPrice: 10000, taxRatePercent: 18, ...overrides };
}

function invoice(overrides: Partial<TaxInvoiceInput> = {}): TaxInvoiceInput {
  return {
    mode: 'gst',
    supplierStateCode: '27',
    pricesIncludeTax: false,
    roundOff: false,
    lines: [line()],
    ...overrides,
  };
}

const charge = (overrides: Partial<AdditionalCharge> = {}): AdditionalCharge => ({
  id: 'c1',
  label: 'Delivery',
  amount: 5000,
  taxable: false,
  ...overrides,
});

export function handWrittenTaxCases(): TaxContractCase[] {
  return [
    { name: 'intra-state splits CGST/SGST', input: invoice({ placeOfSupplyStateCode: '27' }) },
    { name: 'inter-state charges IGST', input: invoice({ placeOfSupplyStateCode: '29' }) },
    { name: 'walk-in sale without place of supply is intra-state', input: invoice() },
    {
      name: 'odd paisa of tax goes to CGST',
      input: invoice({ lines: [line({ unitPrice: 3333, taxRatePercent: 5 })] }),
    },
    {
      name: 'tax backed out of an inclusive price',
      input: invoice({ pricesIncludeTax: true, lines: [line({ unitPrice: 11800 })] }),
    },
    ...[25000, 9900, 19999, 4999, 100, 1, 2, 3].map((mrp) => ({
      name: `inclusive MRP ${mrp} stays within a paisa`,
      input: invoice({ pricesIncludeTax: true, lines: [line({ unitPrice: mrp })] }),
    })),
    {
      name: 'line discount by amount',
      input: invoice({ lines: [line({ discount: { kind: 'amount', value: 1000 } })] }),
    },
    {
      name: 'line discount by percent',
      input: invoice({ lines: [line({ discount: { kind: 'percent', value: 10 } })] }),
    },
    {
      name: 'fractional percent line discount',
      input: invoice({
        lines: [line({ unitPrice: 9999, discount: { kind: 'percent', value: 7.5 } })],
      }),
    },
    {
      name: 'oversized discount clamps to the line',
      input: invoice({ lines: [line({ discount: { kind: 'amount', value: 50000 } })] }),
    },
    {
      name: 'negative discount is rejected',
      input: invoice({ lines: [line({ discount: { kind: 'amount', value: -1 } })] }),
    },
    {
      name: 'bill discount apportioned by line value',
      input: invoice({
        lines: [
          line({ id: 'a', unitPrice: 10000 }),
          line({ id: 'b', unitPrice: 20000 }),
          line({ id: 'c', unitPrice: 30000 }),
        ],
        billDiscount: { kind: 'amount', value: 1000 },
      }),
    },
    {
      name: 'bill discount apportionment with equal weights (tie-break by line order)',
      input: invoice({
        lines: [line({ id: 'a' }), line({ id: 'b' }), line({ id: 'c' })],
        billDiscount: { kind: 'amount', value: 1000 },
      }),
    },
    {
      name: 'fully discounted line takes no bill discount',
      input: invoice({
        lines: [
          line({ id: 'free', discount: { kind: 'percent', value: 100 } }),
          line({ id: 'paid' }),
        ],
        billDiscount: { kind: 'amount', value: 500 },
      }),
    },
    {
      name: 'bill discount by fractional percent across mixed rates',
      input: invoice({
        lines: [
          line({ id: 'a', unitPrice: 3333, quantity: 2500, taxRatePercent: 5 }),
          line({ id: 'b', unitPrice: 19999, taxRatePercent: 18 }),
          line({ id: 'c', unitPrice: 777, quantity: 7000, taxRatePercent: 12 }),
        ],
        billDiscount: { kind: 'percent', value: 33.33 },
        roundOff: true,
      }),
    },
    {
      name: 'non-taxable charge added after tax',
      input: invoice({ additionalCharges: [charge()] }),
    },
    {
      name: 'taxable charge at its own rate',
      input: invoice({
        additionalCharges: [charge({ label: 'Packing', taxable: true, taxRatePercent: 18 })],
      }),
    },
    {
      name: 'taxable charge inter-state',
      input: invoice({
        placeOfSupplyStateCode: '29',
        additionalCharges: [charge({ label: 'Packing', taxable: true, taxRatePercent: 5 })],
      }),
    },
    {
      name: 'taxable charge without a rate is rejected',
      input: invoice({ additionalCharges: [charge({ taxable: true })] }),
    },
    {
      name: 'taxable charge with an unnotified rate is rejected',
      input: invoice({ additionalCharges: [charge({ taxable: true, taxRatePercent: 7 })] }),
    },
    {
      name: 'cess on top of GST, exclusive',
      input: invoice({ lines: [line({ taxRatePercent: 28, cessRatePercent: 12 })] }),
    },
    {
      name: 'cess included when backing tax out',
      input: invoice({
        pricesIncludeTax: true,
        lines: [line({ unitPrice: 14000, taxRatePercent: 28, cessRatePercent: 12 })],
      }),
    },
    {
      name: 'round-off up with adjustment reported',
      input: invoice({ roundOff: true, lines: [line({ unitPrice: 9999 })] }),
    },
    {
      name: 'round-off down (negative adjustment)',
      input: invoice({ roundOff: true, lines: [line({ unitPrice: 10041 })] }),
    },
    {
      name: 'round-off at exactly half a rupee rounds away from zero',
      input: invoice({ roundOff: true, mode: 'non_gst', lines: [line({ unitPrice: 10050 })] }),
    },
    {
      name: 'round-off disabled leaves paise',
      input: invoice({ lines: [line({ unitPrice: 9999 })] }),
    },
    { name: 'non-GST mode charges no tax', input: invoice({ mode: 'non_gst' }) },
    { name: 'composition mode charges no tax', input: invoice({ mode: 'composition' }) },
    {
      name: 'non-GST mode does not validate rates',
      input: invoice({ mode: 'non_gst', lines: [line({ taxRatePercent: 7 })] }),
    },
    {
      name: 'non-GST inclusive price is taken as-is',
      input: invoice({
        mode: 'non_gst',
        pricesIncludeTax: true,
        lines: [line({ unitPrice: 11800 })],
      }),
    },
    {
      name: 'summaries group by rate and HSN',
      input: invoice({
        lines: [
          line({ id: 'a', taxRatePercent: 5, hsnCode: '1001' }),
          line({ id: 'b', taxRatePercent: 18, hsnCode: '2002' }),
          line({ id: 'c', taxRatePercent: 5, hsnCode: '1001' }),
          line({ id: 'd' }),
        ],
      }),
    },
    {
      name: 'HSN summary sorts codes lexically',
      input: invoice({
        lines: [
          line({ id: 'a', hsnCode: '9983' }),
          line({ id: 'b', hsnCode: '1001' }),
          line({ id: 'c', hsnCode: '30049099' }),
        ],
      }),
    },
    {
      name: 'rate summary includes a taxable charge under its rate',
      input: invoice({
        lines: [line({ taxRatePercent: 5 })],
        additionalCharges: [charge({ taxable: true, taxRatePercent: 5 })],
      }),
    },
    {
      name: 'low rates 0.25 and 3 percent',
      input: invoice({
        lines: [
          line({ id: 'a', taxRatePercent: 0.25, unitPrice: 123456 }),
          line({ id: 'b', taxRatePercent: 3, unitPrice: 98765 }),
        ],
      }),
    },
    { name: 'zero-rated line', input: invoice({ lines: [line({ taxRatePercent: 0 })] }) },
    {
      name: '40 percent rate is notified under the contract rules',
      input: invoice({ lines: [line({ taxRatePercent: 40 })] }),
    },
    {
      name: 'fractional quantity in thousandths',
      input: invoice({ lines: [line({ quantity: 1234, unitPrice: 9999 })] }),
    },
    {
      name: 'large quantity and price',
      input: invoice({ lines: [line({ quantity: 99_999_000, unitPrice: 9_999_999 })] }),
    },
    { name: 'empty lines are rejected', input: invoice({ lines: [] }) },
    {
      name: 'fractional thousandths are rejected',
      input: invoice({ lines: [line({ quantity: 1.5 })] }),
    },
    { name: 'zero quantity is rejected', input: invoice({ lines: [line({ quantity: 0 })] }) },
    { name: 'negative price is rejected', input: invoice({ lines: [line({ unitPrice: -1 })] }) },
    { name: 'non-numeric state code is rejected', input: invoice({ supplierStateCode: 'MH' }) },
    {
      name: 'unnotified line rate in GST mode is rejected',
      input: invoice({ lines: [line({ taxRatePercent: 7 })] }),
    },

    // --- Supply classification, reverse charge, exports and SEZ -------------
    {
      name: 'exempt line bears no tax although a rate is recorded',
      input: invoice({ lines: [line({ supplyCategory: 'exempt', taxRatePercent: 18 })] }),
    },
    {
      name: 'nil-rated line bears no tax',
      input: invoice({ lines: [line({ supplyCategory: 'nil_rated', taxRatePercent: 5 })] }),
    },
    {
      name: 'non-GST line bears no tax',
      input: invoice({ lines: [line({ supplyCategory: 'non_gst', taxRatePercent: 12 })] }),
    },
    {
      name: 'mixed classifications total separately',
      input: invoice({
        lines: [
          line({ id: 'a', taxRatePercent: 18 }),
          line({ id: 'b', taxRatePercent: 18, supplyCategory: 'exempt' }),
          line({ id: 'c', taxRatePercent: 5, supplyCategory: 'nil_rated' }),
          line({ id: 'd', taxRatePercent: 0, supplyCategory: 'non_gst' }),
        ],
      }),
    },
    {
      name: 'an unnotified rate on an exempt line is not validated',
      input: invoice({ lines: [line({ supplyCategory: 'exempt', taxRatePercent: 7 })] }),
    },
    {
      name: 'classification applies to an inclusive price too',
      input: invoice({
        pricesIncludeTax: true,
        lines: [line({ unitPrice: 11800, supplyCategory: 'exempt', taxRatePercent: 18 })],
      }),
    },
    {
      name: 'bill discount apportions across classifications',
      input: invoice({
        lines: [
          line({ id: 'a', unitPrice: 10000, taxRatePercent: 18 }),
          line({ id: 'b', unitPrice: 20000, taxRatePercent: 18, supplyCategory: 'exempt' }),
        ],
        billDiscount: { kind: 'percent', value: 10 },
        roundOff: true,
      }),
    },
    {
      name: 'reverse charge carries no tax but reports the value',
      input: invoice({ isReverseCharge: true, lines: [line({ taxRatePercent: 18 })] }),
    },
    {
      name: 'reverse charge inter-state carries no IGST',
      input: invoice({
        isReverseCharge: true,
        placeOfSupplyStateCode: '29',
        lines: [line({ taxRatePercent: 18 })],
      }),
    },
    {
      name: 'reverse charge on an inclusive price takes the price as-is',
      input: invoice({
        isReverseCharge: true,
        pricesIncludeTax: true,
        lines: [line({ unitPrice: 11800 })],
      }),
    },
    {
      name: 'export with payment of tax charges IGST',
      input: invoice({
        supplyType: 'export_with_tax',
        placeOfSupplyStateCode: '96',
        lines: [line({ taxRatePercent: 18 })],
      }),
    },
    {
      name: 'export without payment of tax is zero-rated',
      input: invoice({
        supplyType: 'export_without_tax',
        placeOfSupplyStateCode: '96',
        lines: [line({ taxRatePercent: 18 })],
      }),
    },
    {
      name: 'SEZ with payment of tax charges IGST',
      input: invoice({
        supplyType: 'sez_with_tax',
        placeOfSupplyStateCode: '29',
        lines: [line({ taxRatePercent: 18 })],
      }),
    },
    {
      name: 'SEZ without payment of tax is zero-rated',
      input: invoice({
        supplyType: 'sez_without_tax',
        placeOfSupplyStateCode: '29',
        lines: [line({ taxRatePercent: 18 })],
      }),
    },
    {
      name: 'a taxable charge on a zero-rated export bears no tax',
      input: invoice({
        supplyType: 'export_without_tax',
        placeOfSupplyStateCode: '96',
        lines: [line({ taxRatePercent: 18 })],
        additionalCharges: [charge({ taxable: true, taxRatePercent: 18 })],
      }),
    },
    {
      name: 'an export whose place of supply is the supplier state is rejected',
      input: invoice({
        supplyType: 'export_without_tax',
        placeOfSupplyStateCode: '27',
        lines: [line()],
      }),
    },
    {
      name: 'a declared inter-state supply overrides the derived one',
      input: invoice({ supplyType: 'inter_state', lines: [line({ taxRatePercent: 18 })] }),
    },
    {
      name: 'a line with no HSN is reported under the unclassified bucket',
      input: invoice({
        lines: [line({ id: 'a', hsnCode: '1001' }), line({ id: 'b' })],
      }),
    },
  ];
}

const STATE_CODES = ['07', '09', '19', '24', '27', '29', '33', '36'] as const;
const HSN_CODES = ['1001', '0402', '2202', '3004', '6109', '8517', '9983', '30049099'] as const;
const CESS_RATES = [1, 5, 12, 15, 22] as const;
const PERCENT_DISCOUNTS = [2.5, 5, 7.5, 10, 12.5, 15, 33.33, 50, 66.67, 100] as const;

function randomDiscount(rng: Rng, base: number): Discount {
  if (rng.chance(0.5)) return { kind: 'percent', value: rng.pick(PERCENT_DISCOUNTS) };
  // Occasionally larger than the base, to exercise clamping.
  return { kind: 'amount', value: rng.int(0, Math.max(Math.floor(base * 1.2), 1)) };
}

function randomUnitPrice(rng: Rng): number {
  switch (rng.int(0, 3)) {
    case 0:
      return rng.int(1, 999); // under ₹10
    case 1:
      return rng.int(1000, 99_999); // ₹10–₹1000
    case 2:
      return rng.int(100_000, 9_999_999); // ₹1000–₹1 lakh
    default:
      return rng.pick([9999, 19999, 24999, 49999, 99999, 100, 500, 1000]); // MRP-style
  }
}

function randomQuantity(rng: Rng): number {
  return rng.chance(0.6) ? rng.int(1, 99) * 1000 : rng.int(1, 99_999);
}

function randomLine(rng: Rng, index: number, gstMode: boolean): TaxLineInput {
  const unitPrice = randomUnitPrice(rng);
  const quantity = randomQuantity(rng);
  const taxRatePercent = gstMode ? rng.pick(CONTRACT_GST_RATES) : rng.pick([0, 5, 12, 18, 28]);
  const out: TaxLineInput = {
    id: `l${index + 1}`,
    quantity,
    unitPrice,
    taxRatePercent,
    ...(taxRatePercent === 28 && rng.chance(0.4) ? { cessRatePercent: rng.pick(CESS_RATES) } : {}),
    ...(rng.chance(0.4)
      ? { discount: randomDiscount(rng, Math.round((unitPrice * quantity) / 1000)) }
      : {}),
    ...(rng.chance(0.6) ? { hsnCode: rng.pick(HSN_CODES) } : {}),
  };
  return out;
}

function randomCharges(rng: Rng): AdditionalCharge[] {
  const count = rng.pick([0, 0, 0, 1, 1, 2]);
  const charges: AdditionalCharge[] = [];
  for (let i = 0; i < count; i += 1) {
    const taxable = rng.chance(0.5);
    charges.push({
      id: `c${i + 1}`,
      label: rng.pick(['Delivery', 'Packing', 'Installation', 'Handling']),
      amount: rng.int(100, 99_999),
      taxable,
      ...(taxable ? { taxRatePercent: rng.pick(CONTRACT_GST_RATES) } : {}),
    });
  }
  return charges;
}

export function randomTaxCases(): TaxContractCase[] {
  const rng = new Rng(RANDOM_SEED);
  const cases: TaxContractCase[] = [];
  for (let i = 0; i < RANDOM_CASE_COUNT; i += 1) {
    const modeRoll = rng.next();
    const mode = modeRoll < 0.8 ? 'gst' : modeRoll < 0.92 ? 'non_gst' : 'composition';
    const supplierStateCode = rng.pick(STATE_CODES);
    const posRoll = rng.next();
    const placeOfSupplyStateCode =
      posRoll < 0.3 ? undefined : posRoll < 0.7 ? supplierStateCode : rng.pick(STATE_CODES);
    const lineCount = rng.int(1, 8);
    const lines = Array.from({ length: lineCount }, (_, index) =>
      randomLine(rng, index, mode === 'gst'),
    );
    const gross = lines.reduce((acc, l) => acc + Math.round((l.unitPrice * l.quantity) / 1000), 0);

    cases.push({
      name: `random #${i + 1}`,
      input: {
        mode,
        supplierStateCode,
        ...(placeOfSupplyStateCode !== undefined ? { placeOfSupplyStateCode } : {}),
        pricesIncludeTax: rng.chance(0.5),
        lines,
        ...(rng.chance(0.35) ? { billDiscount: randomDiscount(rng, gross) } : {}),
        ...(rng.chance(0.4) ? { additionalCharges: randomCharges(rng) } : {}),
        roundOff: rng.chance(0.5),
      },
    });
  }
  return cases;
}

export function allTaxCases(): TaxContractCase[] {
  return [...handWrittenTaxCases(), ...randomTaxCases()];
}
