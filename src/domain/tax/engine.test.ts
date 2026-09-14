/**
 * Tax engine tests.
 *
 * These are the behavioural specification. When the Dart port lands in the
 * Flutter app, it runs the shared vectors in `vectors.json`; the cases here
 * additionally cover the reasoning behind each rule, so a future change that
 * "simplifies" one of them fails with an explanation rather than a bare
 * number mismatch.
 */
import { describe, expect, it } from 'vitest';
import { computeInvoice, resolveSupplyType } from './engine.js';
import type { TaxInvoiceInput, TaxLineInput } from './types.js';
import { ValidationError } from '../../lib/errors.js';

/** A minimal registered-dealer invoice, overridable per test. */
function invoice(overrides: Partial<TaxInvoiceInput> = {}): TaxInvoiceInput {
  return {
    mode: 'gst',
    supplierStateCode: '27', // Maharashtra
    pricesIncludeTax: false,
    roundOff: false,
    lines: [line()],
    ...overrides,
  };
}

function line(overrides: Partial<TaxLineInput> = {}): TaxLineInput {
  return {
    id: 'l1',
    quantity: 1000, // 1 unit
    unitPrice: 10000, // ₹100.00
    taxRatePercent: 18,
    ...overrides,
  };
}

describe('supply type', () => {
  it('is intra-state within the supplier state', () => {
    expect(resolveSupplyType('27', '27')).toBe('intra_state');
  });

  it('is inter-state across states', () => {
    expect(resolveSupplyType('27', '29')).toBe('inter_state');
  });

  it('treats an unknown place of supply as intra-state', () => {
    // A walk-in cash sale has no customer record. The goods change hands in
    // the shop, so the supply is intra-state by definition.
    expect(resolveSupplyType('27', undefined)).toBe('intra_state');
  });
});

describe('basic GST', () => {
  it('splits tax into CGST and SGST on an intra-state sale', () => {
    const result = computeInvoice(invoice({ placeOfSupplyStateCode: '27' }));

    expect(result.supplyType).toBe('intra_state');
    expect(result.taxableAmount).toBe(10000);
    expect(result.totalCgst).toBe(900);
    expect(result.totalSgst).toBe(900);
    expect(result.totalIgst).toBe(0);
    expect(result.grandTotal).toBe(11800); // ₹118.00
  });

  it('charges IGST on an inter-state sale', () => {
    const result = computeInvoice(invoice({ placeOfSupplyStateCode: '29' }));

    expect(result.supplyType).toBe('inter_state');
    expect(result.totalIgst).toBe(1800);
    expect(result.totalCgst).toBe(0);
    expect(result.totalSgst).toBe(0);
    expect(result.grandTotal).toBe(11800);
  });

  it('splits an odd paisa so the halves still sum to the total tax', () => {
    // ₹100.05 at 5% = 500.25 paise -> 500. Halves: 250 + 250.
    // ₹33.33 at 5% = 166.65 -> 167. Halves must sum to 167, not 166 or 168.
    const result = computeInvoice(
      invoice({ lines: [line({ unitPrice: 3333, taxRatePercent: 5 })] }),
    );

    expect(result.totalCgst + result.totalSgst).toBe(167);
    expect(result.totalCgst).toBe(84); // the odd paisa goes to CGST
    expect(result.totalSgst).toBe(83);
  });

  it('handles a zero-rated line', () => {
    const result = computeInvoice(invoice({ lines: [line({ taxRatePercent: 0 })] }));

    expect(result.totalTax).toBe(0);
    expect(result.grandTotal).toBe(10000);
  });
});

describe('tax-inclusive pricing', () => {
  it('backs the tax out of an MRP price', () => {
    // ₹118 inclusive at 18% -> ₹100 taxable + ₹18 tax.
    const result = computeInvoice(
      invoice({ pricesIncludeTax: true, lines: [line({ unitPrice: 11800 })] }),
    );

    expect(result.taxableAmount).toBe(10000);
    expect(result.totalTax).toBe(1800);
    expect(result.grandTotal).toBe(11800);
  });

  it('keeps the grand total equal to the MRP the customer was quoted', () => {
    // This is the property that matters in a shop: the sticker says ₹250, the
    // bill must say ₹250. Rounding inside the back-out must not break it.
    for (const mrp of [25000, 9900, 19999, 4999, 100]) {
      const result = computeInvoice(
        invoice({ pricesIncludeTax: true, lines: [line({ unitPrice: mrp })] }),
      );
      expect(Math.abs(result.grandTotal - mrp)).toBeLessThanOrEqual(1);
    }
  });

  it('leaves a zero-rated inclusive price untouched', () => {
    const result = computeInvoice(
      invoice({ pricesIncludeTax: true, lines: [line({ taxRatePercent: 0 })] }),
    );
    expect(result.taxableAmount).toBe(10000);
    expect(result.grandTotal).toBe(10000);
  });
});

describe('discounts', () => {
  it('applies a line-level amount discount before tax', () => {
    const result = computeInvoice(
      invoice({ lines: [line({ discount: { kind: 'amount', value: 1000 } })] }),
    );

    expect(result.totalLineDiscount).toBe(1000);
    expect(result.taxableAmount).toBe(9000);
    expect(result.totalTax).toBe(1620); // 18% of 9000
    expect(result.grandTotal).toBe(10620);
  });

  it('applies a line-level percentage discount', () => {
    const result = computeInvoice(
      invoice({ lines: [line({ discount: { kind: 'percent', value: 10 } })] }),
    );
    expect(result.totalLineDiscount).toBe(1000);
    expect(result.taxableAmount).toBe(9000);
  });

  it('clamps a discount larger than the line rather than going negative', () => {
    // A ₹500 discount on a ₹100 line must not create negative tax and hand
    // the customer a credit the shop never agreed to.
    const result = computeInvoice(
      invoice({ lines: [line({ discount: { kind: 'amount', value: 50000 } })] }),
    );

    expect(result.taxableAmount).toBe(0);
    expect(result.totalTax).toBe(0);
    expect(result.grandTotal).toBe(0);
  });

  it('rejects a negative discount', () => {
    expect(() =>
      computeInvoice(invoice({ lines: [line({ discount: { kind: 'amount', value: -100 } })] })),
    ).toThrow(ValidationError);
  });

  it('apportions a bill discount across lines so the parts sum exactly', () => {
    const result = computeInvoice(
      invoice({
        lines: [
          line({ id: 'a', unitPrice: 10000 }),
          line({ id: 'b', unitPrice: 20000 }),
          line({ id: 'c', unitPrice: 30000 }),
        ],
        billDiscount: { kind: 'amount', value: 1000 },
      }),
    );

    const apportioned = result.lines.map((l) => l.apportionedBillDiscount);
    expect(apportioned.reduce((a, b) => a + b, 0)).toBe(1000);
    // Weighted by line value: 1:2:3 of ₹10 is ₹1.67 / ₹3.33 / ₹5.00.
    expect(apportioned).toEqual([167, 333, 500]);
  });

  it('never loses a paisa when the bill discount does not divide evenly', () => {
    // Three equal lines and a 100-paise discount: 33.33 each. The engine must
    // still hand out exactly 100.
    const result = computeInvoice(
      invoice({
        lines: [line({ id: 'a' }), line({ id: 'b' }), line({ id: 'c' })],
        billDiscount: { kind: 'amount', value: 100 },
      }),
    );

    const total = result.lines.reduce((acc, l) => acc + l.apportionedBillDiscount, 0);
    expect(total).toBe(100);
  });

  it('gives a fully-discounted line no share of the bill discount', () => {
    const result = computeInvoice(
      invoice({
        lines: [
          line({ id: 'free', discount: { kind: 'percent', value: 100 } }),
          line({ id: 'paid' }),
        ],
        billDiscount: { kind: 'amount', value: 500 },
      }),
    );

    expect(result.lines[0]?.apportionedBillDiscount).toBe(0);
    expect(result.lines[1]?.apportionedBillDiscount).toBe(500);
  });
});

describe('additional charges', () => {
  it('adds a non-taxable charge straight to the total', () => {
    const result = computeInvoice(
      invoice({
        additionalCharges: [{ id: 'c1', label: 'Delivery', amount: 5000, taxable: false }],
      }),
    );

    expect(result.nonTaxableCharges).toBe(5000);
    expect(result.totalTax).toBe(1800); // unchanged by the charge
    expect(result.grandTotal).toBe(16800); // 10000 + 1800 + 5000
  });

  it('taxes a taxable charge at its own rate', () => {
    const result = computeInvoice(
      invoice({
        additionalCharges: [
          { id: 'c1', label: 'Packing', amount: 5000, taxable: true, taxRatePercent: 18 },
        ],
      }),
    );

    expect(result.taxableCharges).toBe(5000);
    expect(result.totalTax).toBe(2700); // 18% of 15000
    expect(result.grandTotal).toBe(17700);
  });

  it('refuses a taxable charge with no rate rather than guessing one', () => {
    expect(() =>
      computeInvoice(
        invoice({
          additionalCharges: [{ id: 'c1', label: 'Packing', amount: 5000, taxable: true }],
        }),
      ),
    ).toThrow(/no tax rate/);
  });
});

describe('cess', () => {
  it('charges cess on top of GST', () => {
    const result = computeInvoice(
      invoice({ lines: [line({ taxRatePercent: 28, cessRatePercent: 12 })] }),
    );

    expect(result.totalCgst + result.totalSgst).toBe(2800);
    expect(result.totalCess).toBe(1200);
    expect(result.grandTotal).toBe(14000);
  });

  it('includes cess when backing tax out of an inclusive price', () => {
    // ₹140 inclusive at 28% + 12% cess -> ₹100 taxable.
    const result = computeInvoice(
      invoice({
        pricesIncludeTax: true,
        lines: [line({ unitPrice: 14000, taxRatePercent: 28, cessRatePercent: 12 })],
      }),
    );

    expect(result.taxableAmount).toBe(10000);
    expect(result.grandTotal).toBe(14000);
  });
});

describe('round-off', () => {
  it('rounds the grand total to the nearest rupee and reports the adjustment', () => {
    // ₹99.99 at 18% = 11798.82 paise -> 11799 -> rounds to 11800.
    const result = computeInvoice(invoice({ roundOff: true, lines: [line({ unitPrice: 9999 })] }));

    expect(result.subTotal).toBe(11799);
    expect(result.roundOff).toBe(1);
    expect(result.grandTotal).toBe(11800);
    expect(result.grandTotal % 100).toBe(0);
  });

  it('rounds down when that is nearer', () => {
    const result = computeInvoice(invoice({ roundOff: true, lines: [line({ unitPrice: 10012 })] }));
    expect(result.grandTotal % 100).toBe(0);
    expect(result.subTotal + result.roundOff).toBe(result.grandTotal);
  });

  it('leaves the total alone when round-off is off', () => {
    const result = computeInvoice(invoice({ roundOff: false, lines: [line({ unitPrice: 9999 })] }));
    expect(result.roundOff).toBe(0);
    expect(result.grandTotal).toBe(11799);
  });
});

describe('non-GST and composition modes', () => {
  it('charges no tax for an unregistered shop', () => {
    const result = computeInvoice(invoice({ mode: 'non_gst' }));

    expect(result.totalTax).toBe(0);
    expect(result.totalCgst).toBe(0);
    expect(result.grandTotal).toBe(10000);
  });

  it('charges no tax for a composition dealer but keeps the notional rate', () => {
    const result = computeInvoice(invoice({ mode: 'composition' }));

    expect(result.totalTax).toBe(0);
    // The rate is retained on the line so the stored document still knows what
    // the item's rate would be on registration.
    expect(result.lines[0]?.taxRatePercent).toBe(18);
    expect(result.grandTotal).toBe(10000);
  });

  it('skips rate validation outside GST mode', () => {
    // An unregistered shop's items may carry no meaningful rate at all.
    expect(() =>
      computeInvoice(invoice({ mode: 'non_gst', lines: [line({ taxRatePercent: 7 })] })),
    ).not.toThrow();
  });
});

describe('summaries', () => {
  it('groups the tax breakup by rate', () => {
    const result = computeInvoice(
      invoice({
        lines: [
          line({ id: 'a', taxRatePercent: 5 }),
          line({ id: 'b', taxRatePercent: 18 }),
          line({ id: 'c', taxRatePercent: 5 }),
        ],
      }),
    );

    expect(result.taxSummary).toHaveLength(2);
    expect(result.taxSummary[0]?.taxRatePercent).toBe(5);
    expect(result.taxSummary[0]?.taxableAmount).toBe(20000); // two lines
    expect(result.taxSummary[1]?.taxRatePercent).toBe(18);
  });

  it('aggregates by HSN for GSTR-1', () => {
    const result = computeInvoice(
      invoice({
        lines: [
          line({ id: 'a', hsnCode: '1001' }),
          line({ id: 'b', hsnCode: '1001' }),
          line({ id: 'c', hsnCode: '2002' }),
        ],
      }),
    );

    expect(result.hsnSummary).toHaveLength(2);
    expect(result.hsnSummary[0]?.hsnCode).toBe('1001');
    expect(result.hsnSummary[0]?.quantity).toBe(2000); // 1 + 1 unit
    expect(result.hsnSummary[0]?.taxableAmount).toBe(20000);
  });

  it('omits lines with no HSN from the HSN summary', () => {
    const result = computeInvoice(
      invoice({ lines: [line({ id: 'a', hsnCode: '1001' }), line({ id: 'b' })] }),
    );
    expect(result.hsnSummary).toHaveLength(1);
  });
});

describe('internal consistency', () => {
  it('always has line totals summing to the invoice total', () => {
    // The invariant a customer can check with a calculator. If the printed
    // lines do not add up to the printed total, the bill is wrong.
    const result = computeInvoice(
      invoice({
        placeOfSupplyStateCode: '27',
        lines: [
          line({ id: 'a', unitPrice: 3333, quantity: 2500, taxRatePercent: 5 }),
          line({ id: 'b', unitPrice: 19999, quantity: 1000, taxRatePercent: 18 }),
          line({ id: 'c', unitPrice: 777, quantity: 7000, taxRatePercent: 12 }),
        ],
        billDiscount: { kind: 'percent', value: 7 },
        roundOff: true,
      }),
    );

    const lineSum = result.lines.reduce((acc, l) => acc + l.lineTotal, 0);
    expect(lineSum + result.roundOff).toBe(result.grandTotal);
  });

  it('has the tax summary reconcile with the invoice tax totals', () => {
    const result = computeInvoice(
      invoice({
        lines: [
          line({ id: 'a', taxRatePercent: 5 }),
          line({ id: 'b', taxRatePercent: 12 }),
          line({ id: 'c', taxRatePercent: 28, cessRatePercent: 12 }),
        ],
        additionalCharges: [
          { id: 'ch', label: 'Delivery', amount: 5000, taxable: true, taxRatePercent: 18 },
        ],
      }),
    );

    const summed = result.taxSummary.reduce(
      (acc, row) => ({
        taxable: acc.taxable + row.taxableAmount,
        cgst: acc.cgst + row.cgst,
        sgst: acc.sgst + row.sgst,
        igst: acc.igst + row.igst,
        cess: acc.cess + row.cess,
      }),
      { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 },
    );

    expect(summed.taxable).toBe(result.taxableAmount);
    expect(summed.cgst).toBe(result.totalCgst);
    expect(summed.sgst).toBe(result.totalSgst);
    expect(summed.cess).toBe(result.totalCess);
  });

  it('never produces CGST and IGST on the same invoice', () => {
    // Mixing the two is structurally invalid under GST and would be rejected
    // at filing.
    for (const pos of ['27', '29', undefined]) {
      const result = computeInvoice(
        invoice({
          ...(pos === undefined ? {} : { placeOfSupplyStateCode: pos }),
          lines: [line({ id: 'a' }), line({ id: 'b', taxRatePercent: 5 })],
        }),
      );
      expect(result.totalCgst > 0 && result.totalIgst > 0).toBe(false);
    }
  });
});

describe('input validation', () => {
  it('rejects an empty invoice', () => {
    expect(() => computeInvoice(invoice({ lines: [] }))).toThrow(ValidationError);
  });

  it('rejects a non-integer quantity', () => {
    expect(() => computeInvoice(invoice({ lines: [line({ quantity: 1.5 })] }))).toThrow(
      ValidationError,
    );
  });

  it('rejects a zero or negative quantity', () => {
    expect(() => computeInvoice(invoice({ lines: [line({ quantity: 0 })] }))).toThrow(
      ValidationError,
    );
  });

  it('rejects a negative unit price', () => {
    expect(() => computeInvoice(invoice({ lines: [line({ unitPrice: -1 })] }))).toThrow(
      ValidationError,
    );
  });

  it('rejects an invalid GST rate', () => {
    // 17% is not a GST slab. Catching this here stops a typo becoming a
    // filing mismatch discovered months later.
    expect(() => computeInvoice(invoice({ lines: [line({ taxRatePercent: 17 })] }))).toThrow(
      /not a valid GST rate/,
    );
  });

  it('rejects a malformed state code', () => {
    expect(() => computeInvoice(invoice({ supplierStateCode: 'MH' }))).toThrow(ValidationError);
  });
});
