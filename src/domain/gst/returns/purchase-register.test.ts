import { describe, expect, it } from 'vitest';
import {
  buildPurchaseRegister,
  type InwardDoc,
  type InwardLine,
} from './purchase-register.js';

const line = (over: Partial<InwardLine> = {}): InwardLine => ({
  category: 'taxable',
  hsn: '1006',
  unit: 'KGS',
  quantity: 1000,
  taxable: 100_000,
  ratePercent: 18,
  cgst: 9_000,
  sgst: 9_000,
  igst: 0,
  cess: 0,
  ...over,
});

const doc = (over: Partial<InwardDoc> = {}): InwardDoc => ({
  kind: 'bill',
  id: 'b1',
  number: 'INV-1',
  date: '2026-11-03',
  grandTotal: 118_000,
  supplierName: 'Supplier',
  supplierGstin: '27AAACG1395D1ZU',
  supplierCountry: 'IN',
  supplierTreatment: 'registered_regular',
  composition: false,
  placeOfSupply: '27',
  interState: false,
  reverseCharge: false,
  itcCategory: 'inputs',
  itcEligible: true,
  boeNumber: null,
  boeDate: null,
  boePortCode: null,
  original: null,
  reasonCode: null,
  registerItc: 18_000,
  lines: [line()],
  ...over,
});

const sheet = (r: ReturnType<typeof buildPurchaseRegister>, id: string) => {
  const s = r.sheets.find((x) => x.id === id);
  if (!s) throw new Error(`no sheet ${id}`);
  return s;
};

describe('purchase register', () => {
  it('puts a registered supplier bill in b2b with availed credit', () => {
    const r = buildPurchaseRegister({ docs: [doc()], includeNonTax: true });
    const b2b = sheet(r, 'b2b');
    expect(b2b.rows).toHaveLength(1);
    expect(b2b.totals['taxable']).toBe(100_000);
    expect(b2b.totals['itcCgst']).toBe(9_000);
    expect(r.totals).toEqual({ taxable: 100_000, tax: 18_000, itc: 18_000 });
    expect(r.issues.find((i) => i.code === 'itc_differs_from_register')).toBeUndefined();
  });

  it('shows no availed credit when the bill is ineligible', () => {
    const r = buildPurchaseRegister({
      docs: [doc({ itcCategory: 'ineligible', itcEligible: false, registerItc: null })],
      includeNonTax: true,
    });
    expect(sheet(r, 'b2b').totals['itcCgst']).toBe(0);
    expect(sheet(r, 'b2b').rows[0]?.['eligibility']).toBe('Ineligible');
  });

  it('routes an unregistered supplier to b2bur', () => {
    const r = buildPurchaseRegister({
      docs: [doc({ supplierGstin: null, registerItc: null })],
      includeNonTax: true,
    });
    expect(sheet(r, 'b2bur').rows).toHaveLength(1);
    expect(sheet(r, 'b2b').rows).toHaveLength(0);
  });

  it('routes a bill of entry to impg and an overseas service to imps', () => {
    const goods = doc({
      id: 'g',
      boeNumber: '1000001',
      boeDate: '2026-11-04',
      boePortCode: 'INMAA1',
      supplierGstin: null,
      supplierCountry: 'CN',
      interState: true,
      registerItc: null,
      lines: [line({ cgst: 0, sgst: 0, igst: 18_000 })],
    });
    const services = doc({
      id: 's',
      number: 'SVC-1',
      supplierGstin: null,
      supplierCountry: 'US',
      interState: true,
      itcCategory: 'input_services',
      registerItc: null,
      lines: [line({ cgst: 0, sgst: 0, igst: 18_000 })],
    });
    const r = buildPurchaseRegister({ docs: [goods, services], includeNonTax: true });
    expect(sheet(r, 'impg').rows).toHaveLength(1);
    expect(sheet(r, 'imps').rows).toHaveLength(1);
    expect(sheet(r, 'b2b').rows).toHaveLength(0);
  });

  it('counts composition and non-taxable lines in exemp, not in the rate tables', () => {
    const r = buildPurchaseRegister({
      docs: [
        doc({ id: 'c', composition: true, registerItc: null, lines: [line({ cgst: 0, sgst: 0 })] }),
        doc({
          id: 'n',
          registerItc: null,
          lines: [line({ category: 'nil_rated', cgst: 0, sgst: 0, ratePercent: 0 })],
        }),
      ],
      includeNonTax: true,
    });
    const exemp = sheet(r, 'exemp');
    expect(exemp.totals['composition']).toBe(100_000);
    expect(exemp.totals['nil']).toBe(100_000);
    expect(sheet(r, 'b2b').rows).toHaveLength(0);
  });

  it('leaves non-tax documents and the exemp sheet out when asked', () => {
    const r = buildPurchaseRegister({
      docs: [doc({ lines: [line({ category: 'exempt', cgst: 0, sgst: 0 })], registerItc: null })],
      includeNonTax: false,
    });
    expect(r.sheets.find((s) => s.id === 'exemp')).toBeUndefined();
    expect(r.issues.some((i) => i.code === 'non_tax_documents_left_out')).toBe(true);
  });

  it('nets a debit note against the bill in the HSN summary and reports it in cdnr', () => {
    const note = doc({
      kind: 'debit_note',
      id: 'd1',
      number: 'DN-1',
      grandTotal: 59_000,
      original: { number: 'INV-1', date: '2026-11-03' },
      reasonCode: 'return',
      registerItc: -9_000,
      lines: [line({ taxable: 50_000, cgst: 4_500, sgst: 4_500, quantity: 500 })],
    });
    const r = buildPurchaseRegister({ docs: [doc(), note], includeNonTax: true });
    const hsn = sheet(r, 'hsnsum');
    expect(hsn.totals['taxable']).toBe(50_000);
    expect(hsn.totals['quantity']).toBe(500);
    const cdnr = sheet(r, 'cdnr');
    expect(cdnr.rows[0]?.['reason']).toBe('01-Sales Return');
    expect(r.totals.itc).toBe(9_000);
    expect(r.issues.find((i) => i.code === 'itc_differs_from_register')).toBeUndefined();
  });

  it('warns when the register disagrees with the credit shown', () => {
    const r = buildPurchaseRegister({ docs: [doc({ registerItc: 1 })], includeNonTax: true });
    expect(r.issues.some((i) => i.code === 'itc_differs_from_register')).toBe(true);
  });
});
