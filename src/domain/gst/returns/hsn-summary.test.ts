import { describe, expect, it } from 'vitest';
import type { EngineDoc, EngineLine } from './gstr1-engine.js';
import { buildGstr1 } from './gstr1-engine.js';
import { buildHsnSales, buildSacReport, isServiceCode } from './hsn-summary.js';
import type { InwardDoc } from './purchase-register.js';

const line = (over: Partial<EngineLine> = {}): EngineLine => ({
  category: 'taxable',
  hsn: '6109',
  uqc: 'PCS',
  quantity: 2000,
  taxable: 100_000,
  ratePercent: 18,
  cgst: 9_000,
  sgst: 9_000,
  igst: 0,
  cess: 0,
  ...over,
});

const doc = (over: Partial<EngineDoc> = {}): EngineDoc => ({
  kind: 'invoice',
  id: 'i1',
  number: 'INV-1',
  date: '2026-11-03',
  status: 'issued',
  irnState: 'not_required',
  supplyType: 'intra_state',
  placeOfSupply: '27',
  customerGstin: null,
  customerUin: null,
  customerName: null,
  buyerTreatment: null,
  grandTotal: 118_000,
  reverseCharge: false,
  salesChannel: null,
  ecoGstin: null,
  original: null,
  lines: [line()],
  ...over,
});

describe('sales summary by HSN', () => {
  it('nets credit notes and splits registered from other buyers', () => {
    const docs = [
      doc({ id: 'a', customerGstin: '27AAACG1395D1ZU' }),
      doc({ id: 'b' }),
      doc({
        id: 'c',
        kind: 'credit_note',
        number: 'CN-1',
        lines: [line({ taxable: 50_000, cgst: 4_500, sgst: 4_500, quantity: 1000 })],
      }),
    ];
    const { sheets } = buildHsnSales(docs);
    const all = sheets.find((s) => s.id === 'hsn_all')!;
    const b2b = sheets.find((s) => s.id === 'hsn_b2b')!;
    const b2c = sheets.find((s) => s.id === 'hsn_b2c')!;
    expect(b2b.totals['taxable']).toBe(100_000);
    // 100,000 sale less 50,000 credit note.
    expect(b2c.totals['taxable']).toBe(50_000);
    expect(all.totals['taxable']).toBe(150_000);
    expect(all.totals['quantity']).toBe(3000);
  });

  it('agrees with GSTR-1 Table 12 for the same documents', () => {
    const docs = [
      doc({ id: 'a', customerGstin: '27AAACG1395D1ZU' }),
      doc({ id: 'b' }),
      doc({ id: 'c', kind: 'credit_note', number: 'CN-1', lines: [line({ taxable: 40_000, cgst: 3_600, sgst: 3_600, quantity: 500 })] }),
    ];
    const g1 = buildGstr1({
      gstin: '27AAACG1395D1ZU',
      period: { year: 2026, month: 11 },
      documents: docs,
      options: { excludeEinvoiceFromPortal: false },
    });
    const mine = buildHsnSales(docs).sheets;
    for (const id of ['hsn_b2b', 'hsn_b2c']) {
      expect(mine.find((s) => s.id === id)!.rows).toEqual(g1.sheets.find((s) => s.id === id)!.rows);
    }
  });

  it('leaves out pending-IRN and cancelled documents and says so', () => {
    const { sheets, issues } = buildHsnSales([
      doc({ status: 'pending_irn' }),
      doc({ id: 'v', status: 'void' }),
    ]);
    expect(sheets.find((s) => s.id === 'hsn_all')!.rows).toHaveLength(0);
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['pending_irn_excluded', 'void_or_withdrawn_excluded']),
    );
  });

  it('reports a missing code as NA with a warning, and fills descriptions from the master', () => {
    const { sheets, issues } = buildHsnSales(
      [doc({ lines: [line({ hsn: null }), line({ hsn: '6109' })] })],
      new Map([['6109', 'T-shirts']]),
    );
    const rows = sheets.find((s) => s.id === 'hsn_all')!.rows;
    expect(rows.map((r) => r['hsn'])).toEqual(['6109', 'NA']);
    expect(rows[0]?.['description']).toBe('T-shirts');
    expect(issues.some((i) => i.code === 'hsn_missing')).toBe(true);
  });
});

describe('SAC report', () => {
  const inward = (over: Partial<InwardDoc> = {}): InwardDoc => ({
    kind: 'bill',
    id: 'p1',
    number: 'S-1',
    date: '2026-11-04',
    grandTotal: 23_600,
    supplierName: 'Consultant',
    supplierGstin: '27AAACG1395D1ZU',
    supplierCountry: 'IN',
    supplierTreatment: null,
    composition: false,
    placeOfSupply: '27',
    interState: false,
    reverseCharge: false,
    itcCategory: 'input_services',
    itcEligible: true,
    boeNumber: null,
    boeDate: null,
    boePortCode: null,
    original: null,
    reasonCode: null,
    registerItc: null,
    lines: [
      {
        category: 'taxable',
        hsn: '998313',
        unit: null,
        quantity: 1000,
        taxable: 20_000,
        ratePercent: 18,
        cgst: 1_800,
        sgst: 1_800,
        igst: 0,
        cess: 0,
      },
    ],
    ...over,
  });

  const services = new Set<string>();

  it('recognises services by chapter 99 or by the master', () => {
    expect(isServiceCode('998313', services)).toBe(true);
    expect(isServiceCode('6109', services)).toBe(false);
    expect(isServiceCode('1234', new Set(['1234']))).toBe(true);
  });

  it('keeps only service lines and shows returns as their own rows', () => {
    const outward = [
      doc({ lines: [line({ hsn: '995411' }), line({ hsn: '6109' })] }),
      doc({ id: 'r', kind: 'credit_note', lines: [line({ hsn: '995411', taxable: 10_000, cgst: 900, sgst: 900 })] }),
    ];
    const { sheet } = buildSacReport({ outward, inward: [inward()], filter: 'all', masterServices: services });
    expect(sheet.rows.map((r) => `${r['sac']}|${r['transaction']}`)).toEqual([
      '995411|Sale',
      '995411|Sale return',
      '998313|Purchase',
    ]);
    // Sales and purchases are different things to add up, so no totals on the mixed view.
    expect(sheet.columns.some((c) => c.total)).toBe(false);
  });

  it('filters to one transaction type and then totals it', () => {
    const { sheet } = buildSacReport({
      outward: [doc({ lines: [line({ hsn: '995411' })] })],
      inward: [inward()],
      filter: 'purchase',
      masterServices: services,
    });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.totals['taxable']).toBe(20_000);
    expect(sheet.totals['total']).toBe(23_600);
  });

  it('counts lines without a code instead of guessing', () => {
    const { issues } = buildSacReport({
      outward: [doc({ lines: [line({ hsn: null })] })],
      inward: [],
      filter: 'sale',
      masterServices: services,
    });
    expect(issues.find((i) => i.code === 'line_without_code')?.count).toBe(1);
  });
});
