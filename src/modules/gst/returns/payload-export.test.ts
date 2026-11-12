/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- payload assertions walk untyped portal JSON */
import { beforeAll, describe, expect, it } from 'vitest';
import { rupees, gstnDate, gstnPeriod } from '../../../domain/gst/returns/mappers/format.js';
import {
  periodKey,
  selectVersion,
  RegistryError,
  type SchemaRegistry,
} from '../../../domain/gst/returns/registry.js';
import {
  ZERO_TAX,
  type Gstr1Return,
  type Gstr3bReturn,
} from '../../../domain/gst/returns/model.js';
import { buildGstr1, type EngineDoc } from '../../../domain/gst/returns/gstr1-engine.js';
import { exportPayload } from './payload-export.js';
import { loadRegistry } from './schema-store.js';

const GSTIN = '27AAPFU0939F1ZV';
const period = { year: 2026, month: 11 };

const gstr3b: Gstr3bReturn = {
  gstin: GSTIN,
  period,
  outward: {
    taxable: { taxable: 1_000_000, igst: 0, cgst: 90_000, sgst: 90_000, cess: 0 },
    zeroRated: { taxable: 500_000, igst: 0, cess: 0 },
    nilExempt: 25_000,
    inwardReverseCharge: { taxable: 100_000, igst: 0, cgst: 9_000, sgst: 9_000, cess: 0 },
    nonGst: 7,
  },
  interState: {
    unregistered: [{ placeOfSupply: '29', taxable: 300_000, igst: 54_000 }],
    composition: [],
    uin: [],
  },
  itc: {
    available: {
      import_goods: ZERO_TAX,
      import_services: ZERO_TAX,
      reverse_charge: { igst: 0, cgst: 9_000, sgst: 9_000, cess: 0 },
      isd: ZERO_TAX,
      other: { igst: 10_000, cgst: 40_000, sgst: 40_000, cess: 0 },
    },
    reversed: {
      rules_38_42_43_17_5: { igst: 0, cgst: 1_000, sgst: 1_000, cess: 0 },
      other: ZERO_TAX,
    },
    ineligible: { reclaimed_after_reversal: ZERO_TAX, section_16_4_or_pos: ZERO_TAX },
  },
  inwardExempt: {
    gst: { interState: 0, intraState: 12_000 },
    nonGst: { interState: 0, intraState: 0 },
  },
};

const line = (ratePercent: number, taxable: number, igst: number, cgst: number, sgst: number) => ({
  ratePercent,
  value: { taxable, igst, cgst, sgst, cess: 0 },
});

const gstr1: Gstr1Return = {
  gstin: GSTIN,
  period,
  b2b: [
    {
      recipientGstin: '29AABCU9603R1ZX',
      invoices: [
        {
          number: 'INV/26-27/0001',
          date: '2026-11-05',
          value: 1_180_000,
          placeOfSupply: '29',
          reverseCharge: false,
          recipientKind: 'regular',
          lines: [line(18, 500_000, 90_000, 0, 0), line(18, 500_000, 90_000, 0, 0)],
        },
      ],
    },
  ],
  b2cl: [
    {
      placeOfSupply: '29',
      invoices: [
        {
          number: 'INV/26-27/0002',
          date: '2026-11-06',
          value: 29_500_000,
          lines: [line(18, 25_000_000, 4_500_000, 0, 0)],
        },
      ],
    },
  ],
  b2cs: [
    {
      intraState: true,
      placeOfSupply: '27',
      ratePercent: 5,
      viaEcommerce: false,
      value: { taxable: 200_000, igst: 0, cgst: 2_500, sgst: 2_500, cess: 0 },
    },
  ],
  creditDebitNotesRegistered: [
    {
      recipientGstin: '29AABCU9603R1ZX',
      notes: [
        {
          kind: 'credit',
          number: 'CN/26-27/0001',
          date: '2026-11-20',
          value: 118_000,
          placeOfSupply: '29',
          reverseCharge: false,
          recipientKind: 'regular',
          lines: [line(18, 100_000, 18_000, 0, 0)],
        },
      ],
    },
  ],
  creditDebitNotesUnregistered: [],
  exports: [
    {
      exportType: 'with_payment',
      number: 'EXP/26-27/1',
      date: '2026-11-08',
      value: 1_180_000,
      shippingBill: { number: '1234567', date: '2026-11-09', portCode: 'INMAA1' },
      lines: [line(18, 1_000_000, 180_000, 0, 0)],
    },
  ],
  nilExemptNonGst: [
    { supply: 'intra_state_unregistered', nilRated: 5_000, exempt: 0, nonGst: 700 },
  ],
  hsnB2b: [
    {
      hsn: '6109',
      uqc: 'NOS',
      quantity: 2_500,
      ratePercent: 18,
      value: { taxable: 1_000_000, igst: 180_000, cgst: 0, sgst: 0, cess: 0 },
    },
  ],
  hsnB2c: [
    {
      hsn: '61091000',
      uqc: 'NOS',
      quantity: 2_505,
      ratePercent: 5,
      value: { taxable: 200_000, igst: 0, cgst: 2_500, sgst: 2_500, cess: 0 },
    },
  ],
  documentsIssued: [
    {
      code: '1',
      nature: 'Invoices for outward supply',
      from: 'INV/26-27/1',
      to: 'INV/26-27/9',
      total: 9,
      cancelled: 1,
      net: 8,
    },
    {
      code: '1A',
      nature: 'Bill of Supply (Exempt Supply)',
      from: 'BOS/1',
      to: 'BOS/3',
      total: 3,
      cancelled: 0,
      net: 3,
    },
  ],
  otherSections: {},
};

describe('wire formatting', () => {
  it('converts paise without float drift', () => {
    expect(rupees(7)).toBe(0.07);
    expect(rupees(-12_345)).toBe(-123.45);
    expect(rupees(0)).toBe(0);
    expect(() => rupees(1.5)).toThrow();
  });
  it('formats dates and periods the portal way', () => {
    expect(gstnDate('2026-11-05')).toBe('05-11-2026');
    expect(gstnPeriod({ year: 2026, month: 4 })).toBe('042026');
  });
});

describe('registry selection', () => {
  const reg: SchemaRegistry = {
    forms: {
      gstr3b: {
        versions: [
          {
            id: 'a',
            effectiveFrom: null,
            effectiveTo: '2026-12',
            verification: 'schema_verified',
            schemaSnapshot: 'x',
            validation: { kind: 'single', schema: 'a.json' },
          },
          {
            id: 'b',
            effectiveFrom: '2027-01',
            effectiveTo: null,
            verification: 'schema_verified',
            schemaSnapshot: 'y',
            validation: { kind: 'single', schema: 'b.json' },
          },
        ],
      },
    },
  };
  it('picks by return period and switches on the boundary', () => {
    expect(selectVersion(reg, 'gstr3b', { year: 2026, month: 12 }).id).toBe('a');
    expect(selectVersion(reg, 'gstr3b', { year: 2027, month: 1 }).id).toBe('b');
    expect(periodKey({ year: 2027, month: 1 })).toBe('2027-01');
  });
  it('refuses rather than guess when nothing or two entries match', () => {
    expect(() => selectVersion(reg, 'gstr1', period)).toThrow(RegistryError);
    const overlap: SchemaRegistry = {
      forms: {
        gstr3b: {
          versions: [
            ...(reg.forms['gstr3b']?.versions ?? []),
            { ...reg.forms['gstr3b']!.versions[0]!, id: 'c', effectiveTo: null },
          ],
        },
      },
    };
    expect(() => selectVersion(overlap, 'gstr3b', { year: 2027, month: 2 })).toThrow(/Overlapping/);
  });
  it('the shipped registry covers every form it names with a mapper', () => {
    const registry = loadRegistry();
    expect(selectVersion(registry, 'gstr3b', period).id).toBe('gstr3b-v2026.11');
    expect(selectVersion(registry, 'gstr1', period).id).toBe('gstr1-v2026.11');
  });
});

describe('GSTR-3B payload', () => {
  let result!: ReturnType<typeof exportPayload>;
  beforeAll(() => {
    result = exportPayload('gstr3b', gstr3b, period);
  });

  it('validates against the official Save schema and is portal ready', () => {
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.status).toBe('portal_ready');
    expect(result.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps amounts in rupees and codes through the mapper only', () => {
    const p = result.payload as any;
    expect(p.ret_period).toBe('112026');
    expect(p.sup_details.osup_det).toEqual({
      txval: 10_000,
      iamt: 0,
      camt: 900,
      samt: 900,
      csamt: 0,
    });
    expect(p.sup_details.osup_zero).toEqual({ txval: 5_000, iamt: 0, csamt: 0 });
    expect(p.inter_sup.unreg_details).toEqual([{ pos: '29', txval: 3_000, iamt: 540 }]);
    expect(p.itc_elg.itc_avl.map((r: any) => r.ty)).toEqual(['IMPG', 'IMPS', 'ISRC', 'ISD', 'OTH']);
    // 4(C) = 4(A) - 4(B)
    expect(p.itc_elg.itc_net).toEqual({ iamt: 100, camt: 480, samt: 480, csamt: 0 });
  });
});

describe('GSTR-1 payload', () => {
  let result!: ReturnType<typeof exportPayload>;
  beforeAll(() => {
    result = exportPayload('gstr1', gstr1, period);
  });

  it('is portal ready: built from, and checked against, the official Save schema', () => {
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.status).toBe('portal_ready');
    expect(result.portalReady).toBe(true);
  });

  it('merges lines at one rate into a single item and formats dates', () => {
    const p = result.payload as any;
    const inv = p.b2b[0].inv[0];
    expect(inv.idt).toBe('05-11-2026');
    expect(inv.rchrg).toBe('N');
    expect(inv.inv_typ).toBe('R');
    expect(inv.itms).toEqual([
      { num: 1, itm_det: { rt: 18, txval: 10_000, iamt: 1_800, camt: 0, samt: 0, csamt: 0 } },
    ]);
  });

  it('carries IGST and cess only for B2CL, and splits intra-state B2CS', () => {
    const p = result.payload as any;
    expect(p.b2cl[0].inv[0].itms[0].itm_det).toEqual({
      rt: 18,
      txval: 250_000,
      iamt: 45_000,
      csamt: 0,
    });
    expect(p.b2cs[0]).toEqual({
      sply_ty: 'INTRA',
      typ: 'OE',
      pos: '27',
      rt: 5,
      txval: 2_000,
      camt: 25,
      samt: 25,
      csamt: 0,
    });
    expect(p.cdnr[0].nt[0].ntty).toBe('C');
  });

  it('refuses to hide sections it cannot express', () => {
    const withHsn = exportPayload(
      'gstr1',
      { ...gstr1, otherSections: { advances: 3, ecom: 0 } },
      period,
    );
    const unsupported = withHsn.issues.filter((i) => i.code === 'section_unsupported');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]?.path).toBe('advances');
    expect(withHsn.status).toBe('refused');
  });

  it('writes exports, nil, HSN and documents issued in the portal schema shape', () => {
    const p = result.payload as any;
    expect(p.exp[0].exp_typ).toBe('WPAY');
    expect(p.exp[0].inv[0]).toMatchObject({
      inum: 'EXP/26-27/1',
      sbnum: '1234567',
      sbpcode: 'INMAA1',
      sbdt: '09-11-2026',
    });
    expect(p.exp[0].inv[0].itms[0]).toEqual({ rt: 18, txval: 10_000, iamt: 1_800, csamt: 0 });
    expect(p.nil.inv).toEqual([{ sply_ty: 'INTRAB2C', nil_amt: 50, expt_amt: 0, ngsup_amt: 7 }]);
    expect(p.hsn.hsn_b2b[0]).toMatchObject({
      num: 1,
      hsn_sc: '6109',
      uqc: 'NOS',
      qty: 2.5,
      rt: 18,
    });
    expect(p.hsn.hsn_b2b[0].val).toBeUndefined();
    expect(p.doc_issue.doc_det_new.map((d: any) => d.doc_num)).toEqual(['1', '1A']);
    expect(p.doc_issue.doc_det_new[0].docs[0]).toEqual({
      num: 1,
      from: 'INV/26-27/1',
      to: 'INV/26-27/9',
      totnum: 9,
      cancel: 1,
      net_issue: 8,
    });
  });

  it('reports rounding of a three-decimal HSN quantity instead of hiding it', () => {
    expect(result.issues.some((i) => i.code === 'hsn_quantity_rounded')).toBe(true);
    expect((result.payload as any).hsn.hsn_b2c[0].qty).toBe(2.51);
  });

  it('refuses an HSN code the portal would reject', () => {
    const bad = exportPayload(
      'gstr1',
      { ...gstr1, hsnB2b: [{ ...gstr1.hsnB2b[0]!, hsn: 'NA' }] },
      period,
    );
    expect(bad.issues.some((i) => i.code === 'hsn_code_invalid')).toBe(true);
    expect(bad.status).toBe('refused');
  });

  it('rejects output that breaks the official schema', () => {
    const bad = exportPayload(
      'gstr1',
      {
        ...gstr1,
        b2b: [
          {
            recipientGstin: '29AABCU9603R1ZX',
            invoices: [{ ...gstr1.b2b[0]!.invoices[0]!, number: 'THIS-NUMBER-IS-TOO-LONG' }],
          },
        ],
      },
      period,
    );
    expect(bad.issues.some((i) => i.code === 'schema_invalid')).toBe(true);
    expect(bad.status).toBe('refused');
  });
});

describe('engine output through the mapper', () => {
  const base: EngineDoc = {
    kind: 'invoice',
    id: 'a',
    number: 'INV/26-27/9',
    date: '2026-11-12',
    status: 'issued',
    irnState: 'not_required',
    supplyType: 'intra_state',
    placeOfSupply: '27',
    customerGstin: '27AABCU9603R1ZM',
    customerUin: null,
    customerName: 'Acme',
    buyerTreatment: 'registered_regular',
    grandTotal: 118_000,
    reverseCharge: false,
    salesChannel: 'direct',
    ecoGstin: null,
    original: null,
    lines: [
      {
        category: 'taxable',
        hsn: '6109',
        uqc: 'NOS',
        quantity: 2_000,
        taxable: 100_000,
        ratePercent: 18,
        cgst: 9_000,
        sgst: 9_000,
        igst: 0,
        cess: 0,
      },
    ],
  };

  it('produces a B2B payload that passes the official schema, and nothing left out', () => {
    const w = buildGstr1({
      gstin: GSTIN,
      period,
      documents: [base],
      options: { excludeEinvoiceFromPortal: true },
    });
    const out = exportPayload('gstr1', w.model, period);
    expect(out.issues.filter((i) => i.code === 'schema_invalid')).toEqual([]);
    const unsupported = out.issues
      .filter((i) => i.code === 'section_unsupported')
      .map((i) => i.path);
    expect(unsupported).toEqual([]);
    expect((out.payload as any).hsn.hsn_b2b[0].hsn_sc).toBe('6109');
    expect(out.status).toBe('portal_ready');
  });
});
