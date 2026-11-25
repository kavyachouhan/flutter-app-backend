import { describe, expect, it } from 'vitest';
import { closingStockItc, remainingMonths } from './closing-stock.js';

const t = (cgst: number) => ({ igst: 0, cgst, sgst: cgst, cess: 0 });

describe('closing-stock ITC (Rule 44)', () => {
  it('follows the rule’s illustration: 4 years 6 months 15 days used leaves 5 months', () => {
    expect(remainingMonths('2021-01-01', '2025-07-16')).toBe(5);
    expect(remainingMonths('2026-01-10', '2026-01-10')).toBe(60);
    expect(remainingMonths('2019-01-01', '2026-01-01')).toBe(0);
  });

  it('matches stock to the latest invoices first and lists stock without invoices', () => {
    const r = closingStockItc(
      '2026-11-30',
      [{ itemId: 'a', itemName: 'Rice', hsn: '1006', quantity: 15_000 }],
      [
        { itemId: 'a', billNumber: 'OLD', supplierGstin: null, date: '2026-01-01', quantity: 10_000, tax: t(1_000) },
        { itemId: 'a', billNumber: 'NEW', supplierGstin: null, date: '2026-10-01', quantity: 10_000, tax: t(2_000) },
      ],
      [],
    );
    // 10 units from NEW (all of its tax) + 5 from OLD (half).
    expect(r.inputs[0]?.invoices).toEqual(['NEW', 'OLD']);
    expect(r.inputs[0]?.tax.cgst).toBe(2_500);
    expect(r.withoutInvoices).toHaveLength(0);

    const short = closingStockItc('2026-11-30', [{ itemId: 'b', itemName: 'Oil', hsn: null, quantity: 1_000 }], [], []);
    expect(short.withoutInvoices[0]?.quantity).toBe(1_000);
  });

  it('takes capital goods at remaining months / 60', () => {
    const r = closingStockItc('2026-12-01', [], [], [
      { registerId: 'c', billNumber: 'CG', supplierGstin: null, date: '2026-01-01', tax: t(6_000) },
    ]);
    // 11 months used: 49 left (part month ignored) -> 6000 x 49/60.
    expect(r.capitalGoods[0]?.remainingMonths).toBe(49);
    expect(r.capitalGoods[0]?.tax.cgst).toBe(4_900);
  });
});
