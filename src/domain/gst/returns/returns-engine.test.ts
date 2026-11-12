import { describe, expect, it } from 'vitest';
import { buildDocsIssued } from './docs-issued.js';
import { buildGstr1, type EngineDoc, type EngineLine } from './gstr1-engine.js';
import { buildGstr3b } from './gstr3b-engine.js';
import { ZERO_TAX, ZERO_TAXED } from './model.js';

const GSTIN = '27AAPFU0939F1ZV';
const period = { year: 2026, month: 11 };

const line = (over: Partial<EngineLine> & { taxable: number; ratePercent: number }): EngineLine => {
  const tax = Math.round((over.taxable * over.ratePercent) / 100);
  return {
    category: 'taxable',
    hsn: '6109',
    uqc: 'NOS',
    quantity: 1000,
    cgst: 0,
    sgst: 0,
    igst: 0,
    cess: 0,
    ...(over.igst === undefined && over.cgst === undefined ? { igst: tax } : {}),
    ...over,
  };
};
const intra = (taxable: number, ratePercent: number): EngineLine => {
  const half = Math.round((taxable * ratePercent) / 200);
  return line({ taxable, ratePercent, cgst: half, sgst: half, igst: 0 });
};

const doc = (over: Partial<EngineDoc> & { number: string; lines: EngineLine[] }): EngineDoc => ({
  kind: 'invoice',
  id: over.number,
  date: '2026-11-10',
  status: 'issued',
  irnState: 'not_required',
  supplyType: 'intra_state',
  placeOfSupply: '27',
  customerGstin: null,
  customerUin: null,
  customerName: null,
  buyerTreatment: 'consumer',
  grandTotal: over.lines.reduce((s, l) => s + l.taxable + l.cgst + l.sgst + l.igst + l.cess, 0),
  reverseCharge: false,
  salesChannel: 'direct',
  ecoGstin: null,
  original: null,
  ...over,
});

const run = (documents: EngineDoc[], excludeEinvoiceFromPortal = true) =>
  buildGstr1({ gstin: GSTIN, period, documents, options: { excludeEinvoiceFromPortal } });

const sheet = (w: ReturnType<typeof run>, id: string) => {
  const s = w.sheets.find((x) => x.id === id);
  if (!s) throw new Error(`no sheet ${id}`);
  return s;
};

describe('GSTR-1 classification', () => {
  it('puts a registered intra-state sale in B2B with the right split', () => {
    const w = run([
      doc({
        number: 'INV/1',
        customerGstin: '27AABCU9603R1ZM',
        customerName: 'Acme',
        buyerTreatment: 'registered_regular',
        lines: [intra(1_000_000, 18)],
      }),
    ]);
    expect(w.model.b2b).toHaveLength(1);
    expect(sheet(w, 'b2b').totals['taxable']).toBe(1_000_000);
    expect(sheet(w, 'b2b').totals['cgst']).toBe(90_000);
    expect(sheet(w, 'b2b').totals['igst']).toBe(0);
  });

  it('splits a mixed bill: taxable lines to B2B, exempt line to table 8 registered', () => {
    const w = run([
      doc({
        number: 'INV/2',
        supplyType: 'inter_state',
        placeOfSupply: '29',
        customerGstin: '29AABCU9603R1ZX',
        lines: [
          line({ taxable: 500_000, ratePercent: 12 }),
          line({ taxable: 200_000, ratePercent: 0, category: 'exempt', igst: 0 }),
        ],
      }),
    ]);
    expect(sheet(w, 'b2b').totals['taxable']).toBe(500_000);
    const nil = sheet(w, 'exemp').rows.find(
      (r) => r['description'] === 'Inter-State supplies to registered persons',
    );
    expect(nil?.['exempt']).toBe(200_000);
    // The invoice value still includes the exempt line.
    expect(sheet(w, 'b2b').rows[0]?.['invoiceValue']).toBe(500_000 + 60_000 + 200_000);
  });

  it('reports a large inter-state unregistered sale as B2CL, a small one as B2CS', () => {
    const w = run([
      doc({
        number: 'INV/3',
        supplyType: 'inter_state',
        placeOfSupply: '29',
        lines: [line({ taxable: 30_000_000, ratePercent: 18 })],
      }),
      doc({
        number: 'INV/4',
        supplyType: 'inter_state',
        placeOfSupply: '29',
        lines: [line({ taxable: 100_000, ratePercent: 18 })],
      }),
    ]);
    expect(w.model.b2cl).toHaveLength(1);
    expect(w.model.b2cl[0]?.invoices).toHaveLength(1);
    expect(w.model.b2cs).toHaveLength(1);
    expect(w.model.b2cs[0]).toMatchObject({
      intraState: false,
      placeOfSupply: '29',
      ratePercent: 18,
    });
  });

  it('keeps an intra-state sale of any size in B2CS', () => {
    const w = run([doc({ number: 'INV/5', lines: [intra(90_000_000, 5)] })]);
    expect(w.model.b2cl).toHaveLength(0);
    expect(w.model.b2cs[0]?.value.taxable).toBe(90_000_000);
  });

  it('sums B2CS tax by rate and place of supply (regression: tax was always zero)', () => {
    const w = run([
      doc({ number: 'S/1', lines: [intra(100_000, 5), intra(200_000, 12)] }),
      doc({ number: 'S/2', lines: [intra(50_000, 5)] }),
    ]);
    const rows = sheet(w, 'b2cs').rows;
    const five = rows.find((r) => r['rate'] === 5);
    expect(five?.['taxable']).toBe(150_000);
    expect(five?.['cgst']).toBe(3_750);
    expect(five?.['sgst']).toBe(3_750);
    expect(sheet(w, 'b2cs').totals['cgst']).toBe(3_750 + 12_000);
  });
});

describe('GSTR-1 notes', () => {
  const registered = { customerGstin: '27AABCU9603R1ZM', buyerTreatment: 'registered_regular' };
  it('lists notes to registered buyers in CDNR, credit and debit', () => {
    const w = run([
      doc({
        number: 'CN/1',
        kind: 'credit_note',
        ...registered,
        lines: [intra(100_000, 18)],
        original: { number: 'INV/1', date: '2026-11-01', grandTotal: 1, supplyType: 'intra_state' },
      }),
      doc({
        number: 'DN/1',
        kind: 'debit_note',
        ...registered,
        lines: [intra(10_000, 18)],
        original: { number: 'INV/1', date: '2026-11-01', grandTotal: 1, supplyType: 'intra_state' },
      }),
    ]);
    expect(w.model.creditDebitNotesRegistered[0]?.notes.map((n) => n.kind)).toEqual([
      'credit',
      'debit',
    ]);
    // Net supply of the period: credit reduces, debit adds.
    expect(w.totals.taxable).toBe(-100_000 + 10_000);
  });

  it('nets a credit note on a small unregistered sale into B2CS instead of listing it', () => {
    const w = run([
      doc({ number: 'S/1', lines: [intra(100_000, 18)] }),
      doc({
        number: 'CN/2',
        kind: 'credit_note',
        lines: [intra(40_000, 18)],
        original: {
          number: 'S/0',
          date: '2026-10-30',
          grandTotal: 50_000,
          supplyType: 'intra_state',
        },
      }),
    ]);
    expect(w.model.creditDebitNotesUnregistered).toHaveLength(0);
    expect(w.model.b2cs[0]?.value.taxable).toBe(60_000);
  });

  it('lists a note on a large inter-state unregistered sale in CDNUR', () => {
    const w = run([
      doc({
        number: 'CN/3',
        kind: 'credit_note',
        supplyType: 'inter_state',
        placeOfSupply: '29',
        lines: [line({ taxable: 100_000, ratePercent: 18 })],
        original: {
          number: 'INV/3',
          date: '2026-10-05',
          grandTotal: 30_000_000,
          supplyType: 'inter_state',
        },
      }),
    ]);
    expect(w.model.creditDebitNotesUnregistered[0]).toMatchObject({ type: 'b2cl', kind: 'credit' });
  });
});

describe('GSTR-1 other supplies', () => {
  it('reports exports and flags the missing shipping bill details', () => {
    const w = run([
      doc({
        number: 'EXP/1',
        supplyType: 'export_with_tax',
        placeOfSupply: '96',
        lines: [line({ taxable: 1_000_000, ratePercent: 18 })],
      }),
    ]);
    expect(sheet(w, 'exp').rows[0]?.['exportType']).toBe('WPAY');
    expect(w.issues.some((i) => i.code === 'export_shipping_bill_missing')).toBe(true);
    expect(w.model.exports).toHaveLength(1);
  });

  it('keeps SEZ supplies with the registered-buyer table under their own invoice type', () => {
    const w = run([
      doc({
        number: 'SEZ/1',
        supplyType: 'sez_with_tax',
        placeOfSupply: '24',
        customerGstin: '24AABCU9603R1ZV',
        lines: [line({ taxable: 100_000, ratePercent: 18 })],
      }),
    ]);
    expect(w.model.b2b[0]?.invoices[0]?.recipientKind).toBe('sez_with_payment');
    expect(w.net.zeroRated.taxable).toBe(100_000);
    expect(w.net.taxable.taxable).toBe(0);
  });

  it('never drops a document silently: pending IRN and cancelled are counted', () => {
    const w = run([
      doc({
        number: 'P/1',
        status: 'pending_irn',
        irnState: 'awaiting',
        lines: [intra(10_000, 5)],
      }),
      doc({ number: 'V/1', status: 'void', lines: [intra(10_000, 5)] }),
      doc({ number: 'OK/1', lines: [intra(10_000, 5)] }),
    ]);
    expect(w.issues.find((i) => i.code === 'pending_irn_excluded')?.count).toBe(1);
    expect(w.issues.find((i) => i.code === 'void_or_withdrawn_excluded')?.count).toBe(1);
    expect(w.totals.taxable).toBe(10_000);
  });

  it('shows e-invoiced bills on screen but keeps them out of the portal model', () => {
    const e = doc({
      number: 'E/1',
      irnState: 'registered',
      customerGstin: '27AABCU9603R1ZM',
      buyerTreatment: 'registered_regular',
      lines: [intra(100_000, 18)],
    });
    const hidden = run([e], true);
    expect(sheet(hidden, 'b2b').rows).toHaveLength(1);
    expect(hidden.model.b2b).toHaveLength(0);
    expect(hidden.totals.taxable).toBe(100_000);
    expect(run([e], false).model.b2b).toHaveLength(1);
  });

  it('builds HSN by registered and unregistered recipient, net of credit notes', () => {
    const w = run([
      doc({
        number: 'B/1',
        customerGstin: '27AABCU9603R1ZM',
        buyerTreatment: 'registered_regular',
        lines: [intra(100_000, 18)],
      }),
      doc({ number: 'C/1', lines: [intra(50_000, 18)] }),
      doc({
        number: 'CN/9',
        kind: 'credit_note',
        lines: [{ ...intra(20_000, 18), quantity: 500 }],
        original: { number: 'C/0', date: '2026-10-01', grandTotal: 1, supplyType: 'intra_state' },
      }),
    ]);
    expect(sheet(w, 'hsn_b2b').totals['taxable']).toBe(100_000);
    expect(sheet(w, 'hsn_b2c').totals['taxable']).toBe(30_000);
    expect(sheet(w, 'hsn_b2c').totals['quantity']).toBe(500);
  });
});

describe('Table 13', () => {
  it('counts cancelled numbers and reports a gap', () => {
    const r = buildDocsIssued([
      { family: 'outward_invoice', seriesId: 's', number: 'INV/1', state: 'issued', sequenceNo: 1 },
      {
        family: 'outward_invoice',
        seriesId: 's',
        number: 'INV/2',
        state: 'cancelled',
        sequenceNo: 2,
      },
      { family: 'outward_invoice', seriesId: 's', number: 'INV/4', state: 'issued', sequenceNo: 4 },
    ]);
    expect(r.sheet.rows[0]).toMatchObject({
      from: 'INV/1',
      to: 'INV/4',
      total: 3,
      cancelled: 1,
      net: 2,
    });
    expect(r.issues[0]?.code).toBe('document_number_gap');
    expect(r.issues[0]?.count).toBe(1);
  });
});

describe('GSTR-3B', () => {
  it('takes outward figures from the same net totals as GSTR-1', () => {
    const g1 = run([
      doc({
        number: 'B/1',
        customerGstin: '27AABCU9603R1ZM',
        buyerTreatment: 'registered_regular',
        lines: [intra(1_000_000, 18)],
      }),
      doc({
        number: 'X/1',
        supplyType: 'inter_state',
        placeOfSupply: '29',
        lines: [line({ taxable: 200_000, ratePercent: 18 })],
      }),
      doc({
        number: 'N/1',
        lines: [line({ taxable: 5_000, ratePercent: 0, category: 'nil_rated', igst: 0 })],
      }),
    ]);
    const g3 = buildGstr3b({
      gstin: GSTIN,
      period,
      gstr1: g1.net,
      inwardReverseCharge: ZERO_TAXED,
      itc: {
        available: {
          import_goods: ZERO_TAX,
          import_services: ZERO_TAX,
          reverse_charge: ZERO_TAX,
          isd: ZERO_TAX,
          other: { igst: 0, cgst: 50_000, sgst: 50_000, cess: 0 },
        },
        reversed: {
          rules_38_42_43_17_5: { igst: 0, cgst: 5_000, sgst: 5_000, cess: 0 },
          other: ZERO_TAX,
        },
        ineligible: { reclaimed_after_reversal: ZERO_TAX, section_16_4_or_pos: ZERO_TAX },
      },
      inwardExempt: {
        gst: { interState: 0, intraState: 0 },
        nonGst: { interState: 0, intraState: 0 },
      },
      outwardReverseChargeDocs: 0,
      pendingItcRows: 0,
    });
    expect(g3.model.outward.taxable.taxable).toBe(1_200_000);
    expect(g3.model.outward.taxable.cgst).toBe(90_000);
    expect(g3.model.outward.taxable.igst).toBe(36_000);
    expect(g3.model.outward.nilExempt).toBe(5_000);
    expect(g3.model.interState.unregistered).toEqual([
      { placeOfSupply: '29', taxable: 200_000, igst: 36_000 },
    ]);
    const itc = g3.sheets.find((s) => s.id === '4');
    expect(itc?.rows.find((r) => String(r['label']).startsWith('(C)'))).toMatchObject({
      cgst: 45_000,
      sgst: 45_000,
    });
    expect(g3.totals.taxable).toBe(g1.totals.taxable);
  });
});
