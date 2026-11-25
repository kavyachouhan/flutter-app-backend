import { describe, expect, it } from 'vitest';
import { splitEcommerce, tcsByOperator } from './ecommerce.js';
import type { EngineDoc } from './gstr1-engine.js';

const ECO = '29AABCU9603R1ZX';
const doc = (over: Partial<EngineDoc>): EngineDoc => ({
  kind: 'invoice',
  id: 'i',
  number: 'INV/1',
  date: '2026-11-10',
  status: 'issued',
  irnState: 'not_applicable',
  supplyType: 'intra_state',
  placeOfSupply: '27',
  customerGstin: null,
  customerUin: null,
  customerName: null,
  buyerTreatment: null,
  grandTotal: 11_800,
  reverseCharge: false,
  salesChannel: 'marketplace',
  ecoGstin: ECO,
  ecoLiability: 'tcs_s52',
  original: null,
  lines: [{ category: 'taxable', hsn: '6109', uqc: 'NOS', quantity: 1000, taxable: 10_000, ratePercent: 18, cgst: 900, sgst: 900, igst: 0, cess: 0 }],
  ...over,
});

describe('table 14', () => {
  it('keeps TCS sales in the regular tables and sums them by operator, net of notes', () => {
    const { forTables, ecommerce } = splitEcommerce([
      doc({}),
      doc({ id: 'c', kind: 'credit_note', number: 'CN/1', lines: [{ category: 'taxable', hsn: '6109', uqc: 'NOS', quantity: 0, taxable: 1_000, ratePercent: 18, cgst: 90, sgst: 90, igst: 0, cess: 0 }] }),
    ]);
    expect(forTables).toHaveLength(2);
    expect(tcsByOperator(ecommerce)[0]?.value.taxable).toBe(9_000);
  });

  it('takes s.9(5) supplies out of the regular tables and reports the operator tax at the rate', () => {
    const { forTables, ecommerce } = splitEcommerce([
      doc({ ecoLiability: 's9_5', lines: [{ category: 'taxable', hsn: '9963', uqc: 'OTH', quantity: 0, taxable: 10_000, ratePercent: 5, cgst: 0, sgst: 0, igst: 0, cess: 0 }] }),
      doc({ salesChannel: 'direct', ecoGstin: null, ecoLiability: null }),
    ]);
    expect(forTables).toHaveLength(1);
    expect(ecommerce.s9_5[0]).toEqual({
      operatorGstin: ECO,
      value: { taxable: 10_000, igst: 0, cgst: 250, sgst: 250, cess: 0 },
    });
  });
});
