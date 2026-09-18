import { describe, expect, it } from 'vitest';
import { computeInvoice, resolveSupplyType } from './engine.js';
import type { TaxEngineRules, TaxInvoiceInput, TaxLineInput } from './types.js';
import { ValidationError } from '../../lib/errors.js';

const RULES: TaxEngineRules = { allowedGstRates: new Set([0, 5, 12, 18, 28]) };

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

function line(overrides: Partial<TaxLineInput> = {}): TaxLineInput {
  return { id: 'l1', quantity: 1000, unitPrice: 10000, taxRatePercent: 18, ...overrides };
}

const compute = (input: TaxInvoiceInput) => computeInvoice(input, RULES);

describe('supply type', () => {
  it('is intra-state within a state and inter-state across states', () => {
    expect(resolveSupplyType('27', '27')).toBe('intra_state');
    expect(resolveSupplyType('27', '29')).toBe('inter_state');
  });

  it('treats an unknown place of supply as intra-state (walk-in sale)', () => {
    expect(resolveSupplyType('27', undefined)).toBe('intra_state');
  });
});

describe('basic GST', () => {
  it('splits tax into CGST and SGST intra-state', () => {
    const result = compute(invoice({ placeOfSupplyStateCode: '27' }));
    expect(result).toMatchObject({
      totalCgst: 900,
      totalSgst: 900,
      totalIgst: 0,
      grandTotal: 11800,
    });
  });

  it('charges IGST inter-state', () => {
    const result = compute(invoice({ placeOfSupplyStateCode: '29' }));
    expect(result).toMatchObject({
      totalIgst: 1800,
      totalCgst: 0,
      totalSgst: 0,
      grandTotal: 11800,
    });
  });

  it('gives the odd paisa to CGST so the halves sum to the tax', () => {
    // 3333 at 5% = 166.65 -> 167
    const result = compute(invoice({ lines: [line({ unitPrice: 3333, taxRatePercent: 5 })] }));
    expect([result.totalCgst, result.totalSgst]).toEqual([84, 83]);
  });
});

describe('tax-inclusive pricing', () => {
  it('backs tax out of an MRP price', () => {
    const result = compute(
      invoice({ pricesIncludeTax: true, lines: [line({ unitPrice: 11800 })] }),
    );
    expect(result).toMatchObject({ taxableAmount: 10000, totalTax: 1800, grandTotal: 11800 });
  });

  it('keeps the total within a paisa of the quoted MRP', () => {
    for (const mrp of [25000, 9900, 19999, 4999, 100]) {
      const result = compute(
        invoice({ pricesIncludeTax: true, lines: [line({ unitPrice: mrp })] }),
      );
      expect(Math.abs(result.grandTotal - mrp)).toBeLessThanOrEqual(1);
    }
  });
});

describe('discounts', () => {
  it('applies line discounts before tax', () => {
    const amount = compute(
      invoice({ lines: [line({ discount: { kind: 'amount', value: 1000 } })] }),
    );
    const percent = compute(
      invoice({ lines: [line({ discount: { kind: 'percent', value: 10 } })] }),
    );
    expect(amount).toMatchObject({ taxableAmount: 9000, totalTax: 1620 });
    expect(percent.taxableAmount).toBe(9000);
  });

  it('clamps an oversized discount instead of producing negative tax', () => {
    const result = compute(
      invoice({ lines: [line({ discount: { kind: 'amount', value: 50000 } })] }),
    );
    expect(result).toMatchObject({ taxableAmount: 0, totalTax: 0, grandTotal: 0 });
  });

  it('rejects a negative discount', () => {
    expect(() =>
      compute(invoice({ lines: [line({ discount: { kind: 'amount', value: -1 } })] })),
    ).toThrow(ValidationError);
  });

  it('apportions a bill discount by line value, summing exactly', () => {
    const result = compute(
      invoice({
        lines: [
          line({ id: 'a', unitPrice: 10000 }),
          line({ id: 'b', unitPrice: 20000 }),
          line({ id: 'c', unitPrice: 30000 }),
        ],
        billDiscount: { kind: 'amount', value: 1000 },
      }),
    );
    expect(result.lines.map((l) => l.apportionedBillDiscount)).toEqual([167, 333, 500]);
  });

  it('gives a fully discounted line no share of the bill discount', () => {
    const result = compute(
      invoice({
        lines: [
          line({ id: 'free', discount: { kind: 'percent', value: 100 } }),
          line({ id: 'paid' }),
        ],
        billDiscount: { kind: 'amount', value: 500 },
      }),
    );
    expect(result.lines.map((l) => l.apportionedBillDiscount)).toEqual([0, 500]);
  });
});

describe('additional charges', () => {
  it('adds non-taxable charges after tax', () => {
    const result = compute(
      invoice({
        additionalCharges: [{ id: 'c', label: 'Delivery', amount: 5000, taxable: false }],
      }),
    );
    expect(result).toMatchObject({ nonTaxableCharges: 5000, totalTax: 1800, grandTotal: 16800 });
  });

  it('taxes a taxable charge at its own rate', () => {
    const result = compute(
      invoice({
        additionalCharges: [
          { id: 'c', label: 'Packing', amount: 5000, taxable: true, taxRatePercent: 18 },
        ],
      }),
    );
    expect(result).toMatchObject({ taxableCharges: 5000, totalTax: 2700, grandTotal: 17700 });
  });

  it('refuses to guess a missing or unnotified charge rate', () => {
    expect(() =>
      compute(
        invoice({
          additionalCharges: [{ id: 'c', label: 'Packing', amount: 5000, taxable: true }],
        }),
      ),
    ).toThrow(/no tax rate/);
    expect(() =>
      compute(
        invoice({
          additionalCharges: [
            { id: 'c', label: 'Packing', amount: 5000, taxable: true, taxRatePercent: 7 },
          ],
        }),
      ),
    ).toThrow(/not a notified GST rate/);
  });
});

describe('cess', () => {
  it('charges cess on top of GST and includes it when backing tax out', () => {
    const exclusive = compute(
      invoice({ lines: [line({ taxRatePercent: 28, cessRatePercent: 12 })] }),
    );
    const inclusive = compute(
      invoice({
        pricesIncludeTax: true,
        lines: [line({ unitPrice: 14000, taxRatePercent: 28, cessRatePercent: 12 })],
      }),
    );
    expect(exclusive).toMatchObject({ totalCess: 1200, grandTotal: 14000 });
    expect(inclusive).toMatchObject({ taxableAmount: 10000, grandTotal: 14000 });
  });
});

describe('round-off', () => {
  it('rounds to the rupee and reports the adjustment', () => {
    const result = compute(invoice({ roundOff: true, lines: [line({ unitPrice: 9999 })] }));
    expect(result).toMatchObject({ subTotal: 11799, roundOff: 1, grandTotal: 11800 });
  });

  it('leaves the total alone when disabled', () => {
    expect(compute(invoice({ lines: [line({ unitPrice: 9999 })] })).grandTotal).toBe(11799);
  });
});

describe('non-GST and composition', () => {
  it('charges no tax but keeps the recorded rate', () => {
    for (const mode of ['non_gst', 'composition'] as const) {
      const result = compute(invoice({ mode }));
      expect(result.totalTax).toBe(0);
      expect(result.lines[0]?.taxRatePercent).toBe(18);
    }
  });

  it('does not validate rates outside GST mode', () => {
    expect(() =>
      compute(invoice({ mode: 'non_gst', lines: [line({ taxRatePercent: 7 })] })),
    ).not.toThrow();
  });
});

describe('summaries and consistency', () => {
  it('groups by rate and by HSN', () => {
    const result = compute(
      invoice({
        lines: [
          line({ id: 'a', taxRatePercent: 5, hsnCode: '1001' }),
          line({ id: 'b', taxRatePercent: 18, hsnCode: '2002' }),
          line({ id: 'c', taxRatePercent: 5, hsnCode: '1001' }),
          line({ id: 'd' }),
        ],
      }),
    );
    expect(result.taxSummary.map((r) => r.taxRatePercent)).toEqual([5, 18]);
    expect(result.hsnSummary).toHaveLength(2);
    expect(result.hsnSummary[0]).toMatchObject({
      hsnCode: '1001',
      quantity: 2000,
      taxableAmount: 20000,
    });
  });

  it('has line totals plus round-off equal to the grand total', () => {
    const result = compute(
      invoice({
        lines: [
          line({ id: 'a', unitPrice: 3333, quantity: 2500, taxRatePercent: 5 }),
          line({ id: 'b', unitPrice: 19999, taxRatePercent: 18 }),
          line({ id: 'c', unitPrice: 777, quantity: 7000, taxRatePercent: 12 }),
        ],
        billDiscount: { kind: 'percent', value: 7 },
        roundOff: true,
      }),
    );
    const lineSum = result.lines.reduce((acc, l) => acc + l.lineTotal, 0);
    expect(lineSum + result.roundOff).toBe(result.grandTotal);
  });
});

describe('validation', () => {
  it('rejects structurally impossible input', () => {
    expect(() => compute(invoice({ lines: [] }))).toThrow(ValidationError);
    expect(() => compute(invoice({ lines: [line({ quantity: 1.5 })] }))).toThrow(ValidationError);
    expect(() => compute(invoice({ lines: [line({ quantity: 0 })] }))).toThrow(ValidationError);
    expect(() => compute(invoice({ lines: [line({ unitPrice: -1 })] }))).toThrow(ValidationError);
    expect(() => compute(invoice({ supplierStateCode: 'MH' }))).toThrow(ValidationError);
  });

  it('validates rates against the rules it is given, not a built-in list', () => {
    const input = invoice({ lines: [line({ taxRatePercent: 40 })] });
    expect(() => compute(input)).toThrow(/not a notified GST rate/);
    expect(() => computeInvoice(input, { allowedGstRates: new Set([40]) })).not.toThrow();
  });
});
