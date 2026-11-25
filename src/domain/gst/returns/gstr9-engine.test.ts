import { describe, expect, it } from 'vitest';
import { buildGstr9, buildItcBreakdown, monthsIn, type Gstr9Input, type Gstr9Period } from './gstr9-engine.js';
import { exportPayload } from '../../../modules/gst/returns/payload-export.js';
import type { Gstr1Return, Gstr3bReturn, TaxedValue } from './model.js';
import { ZERO_TAX } from './model.js';

const tv = (taxable: number, o: Partial<TaxedValue> = {}): TaxedValue => ({
  taxable,
  igst: 0,
  cgst: 0,
  sgst: 0,
  cess: 0,
  ...o,
});

const invoice = (number: string, value: TaxedValue, over: Record<string, unknown> = {}) => ({
  number,
  date: '2026-11-03',
  value: value.taxable + value.igst + value.cgst + value.sgst,
  placeOfSupply: '27',
  reverseCharge: false,
  recipientKind: 'regular' as const,
  lines: [{ ratePercent: 18, value }],
  ...over,
});

/**
 * One period whose GSTR-1 and GSTR-3B agree, worked out by hand:
 * 3.1(a) taxable = 100,000 B2B + 50,000 B2CS + 10,000 outward reverse charge - 10,000 credit note
 *                = 150,000; 3.1(b) = 20,000 export with payment. Together 170,000.
 */
function gstr1(): Gstr1Return {
  return {
    gstin: '27AAACG1395D1ZU',
    period: { year: 2026, month: 11 },
    b2b: [
      {
        recipientGstin: '29AAACG1395D1ZQ',
        invoices: [
          invoice('B1', tv(100_000, { cgst: 9_000, sgst: 9_000 })),
          invoice('R1', tv(10_000), { reverseCharge: true }),
        ],
      },
    ],
    b2cl: [],
    b2cs: [
      {
        intraState: true,
        placeOfSupply: '27',
        ratePercent: 18,
        viaEcommerce: false,
        value: tv(50_000, { cgst: 4_500, sgst: 4_500 }),
      },
    ],
    creditDebitNotesRegistered: [
      {
        recipientGstin: '29AAACG1395D1ZQ',
        notes: [
          {
            kind: 'credit',
            number: 'CN1',
            date: '2026-11-10',
            value: 11_800,
            placeOfSupply: '27',
            reverseCharge: false,
            recipientKind: 'regular',
            lines: [{ ratePercent: 18, value: tv(10_000, { cgst: 900, sgst: 900 }) }],
          },
        ],
      },
    ],
    creditDebitNotesUnregistered: [],
    exports: [
      {
        exportType: 'with_payment',
        number: 'E1',
        date: '2026-11-04',
        value: 23_600,
        lines: [{ ratePercent: 18, value: tv(20_000, { igst: 3_600 }) }],
      },
    ],
    nilExemptNonGst: [
      { supply: 'intra_state_registered', nilRated: 5_000, exempt: 0, nonGst: 2_000 },
    ],
    hsnB2b: [{ hsn: '6109', uqc: 'PCS', quantity: 3_000, ratePercent: 18, value: tv(110_000) }],
    hsnB2c: [{ hsn: '6109', uqc: 'PCS', quantity: 1_000, ratePercent: 18, value: tv(50_000) }],
    documentsIssued: [],
    otherSections: {},
  };
}

function gstr3b(): Gstr3bReturn {
  return {
    gstin: '27AAACG1395D1ZU',
    period: { year: 2026, month: 11 },
    outward: {
      taxable: tv(150_000, { cgst: 12_600, sgst: 12_600 }),
      zeroRated: { taxable: 20_000, igst: 3_600, cess: 0 },
      nilExempt: 5_000,
      inwardReverseCharge: tv(30_000, { cgst: 2_700, sgst: 2_700 }),
      nonGst: 2_000,
    },
    interState: { unregistered: [], composition: [], uin: [] },
    itc: {
      available: {
        import_goods: ZERO_TAX,
        import_services: ZERO_TAX,
        reverse_charge: ZERO_TAX,
        isd: ZERO_TAX,
        other: { igst: 0, cgst: 3_000, sgst: 3_000, cess: 0 },
      },
      reversed: {
        rules_38_42_43_17_5: { igst: 0, cgst: 500, sgst: 500, cess: 0 },
        other: ZERO_TAX,
      },
      ineligible: { reclaimed_after_reversal: ZERO_TAX, section_16_4_or_pos: ZERO_TAX },
    },
    inwardExempt: {
      gst: { interState: 0, intraState: 0 },
      nonGst: { interState: 0, intraState: 0 },
    },
  };
}

const period = (over: Partial<Gstr9Period> = {}): Gstr9Period => ({
  label: 'Nov 2026',
  from: '2026-11-01',
  to: '2026-11-30',
  source: 'filed',
  gstr1: gstr1(),
  gstr3b: gstr3b(),
  ...over,
});

const input = (over: Partial<Gstr9Input> = {}): Gstr9Input => ({
  gstin: '27AAACG1395D1ZU',
  fy: { startYear: 2026, endYear: 2027 },
  periods: [period()],
  considerNonTaxAsExempt: false,
  itc: buildItcBreakdown([
    {
      category: 'inputs',
      reverseCharge: false,
      supplierRegistered: true,
      importGoods: false,
      foreignSupplier: false,
      tax: { igst: 0, cgst: 3_000, sgst: 3_000, cess: 0 },
      rows: 2,
    },
  ]),
  twoB: { monthsImported: 1, monthsExpected: 1, total: { igst: 0, cgst: 3_000, sgst: 3_000, cess: 0 } },
  inward: [],
  books: { outwardTaxable: 170_000, outwardTax: 28_800 },
  ledger: null,
  ...over,
});

const sheet = (w: ReturnType<typeof buildGstr9>, id: string) => {
  const s = w.sheets.find((x) => x.id === id);
  if (!s) throw new Error(`no sheet ${id}`);
  return s;
};
const row = (w: ReturnType<typeof buildGstr9>, id: string, ref: string) => {
  const r = sheet(w, id).rows.find((x) => x['ref'] === ref);
  if (!r) throw new Error(`no row ${ref}`);
  return r;
};
const codes = (w: ReturnType<typeof buildGstr9>) => w.issues.map((i) => i.code);

describe('GSTR-9 Tables 4 and 5', () => {
  const w = buildGstr9(input());

  it('places each supply in its row', () => {
    expect(row(w, 'pt2_outward', '4A')['taxable']).toBe(50_000);
    expect(row(w, 'pt2_outward', '4B')['taxable']).toBe(100_000);
    expect(row(w, 'pt2_outward', '4C')['igst']).toBe(3_600);
    expect(row(w, 'pt2_outward', '4G')['taxable']).toBe(30_000);
    // Outward reverse charge is Table 5C, not 4B.
    expect(row(w, 'pt2_outward', '5C')['taxable']).toBe(10_000);
  });

  it('sub-totals and subtracts credit notes', () => {
    expect(row(w, 'pt2_outward', '4H')['taxable']).toBe(200_000);
    expect(row(w, 'pt2_outward', '4I')['taxable']).toBe(10_000);
    expect(row(w, 'pt2_outward', '4N')['taxable']).toBe(190_000);
    expect(row(w, 'pt2_outward', '4N')['cgst']).toBe(9_000 + 4_500 + 2_700 - 900);
  });

  it('totals the turnover as 4N + 5M', () => {
    // 5C reverse charge 10,000 + 5E nil rated 5,000 + 5F non-GST 2,000.
    expect(row(w, 'pt2_outward', '5M')['taxable']).toBe(17_000);
    expect(row(w, 'pt2_outward', '5N')['taxable']).toBe(190_000 + 17_000);
    expect(w.totals.taxable).toBe(207_000);
  });

  it('reports non-GST as 5F unless told to treat it as exempt', () => {
    expect(row(w, 'pt2_outward', '5F')['taxable']).toBe(2_000);
    expect(row(w, 'pt2_outward', '5D')['taxable']).toBe(0);
    const exempt = buildGstr9(input({ considerNonTaxAsExempt: true }));
    expect(row(exempt, 'pt2_outward', '5D')['taxable']).toBe(2_000);
    expect(row(exempt, 'pt2_outward', '5F')['taxable']).toBe(0);
    // The turnover does not change: it only moves between two rows.
    expect(row(exempt, 'pt2_outward', '5N')['taxable']).toBe(row(w, 'pt2_outward', '5N')['taxable']);
  });
});

describe('GSTR-9 Tables 6 to 9', () => {
  const w = buildGstr9(input());

  it('takes 6A from GSTR-3B and splits 6B from the register', () => {
    expect(row(w, 'pt3_itc', '6A')['cgst']).toBe(3_000);
    expect(row(w, 'pt3_itc', '6B')['cgst']).toBe(3_000);
    expect(row(w, 'pt3_itc', '6I')['cgst']).toBe(3_000);
    expect(row(w, 'pt3_itc', '6J')['cgst']).toBe(0);
    expect(row(w, 'pt3_itc', '6O')['sgst']).toBe(3_000);
  });

  it('shows blocked credit as 7E and nets it off 6O', () => {
    expect(row(w, 'pt3_rev', '7E')['cgst']).toBe(500);
    expect(row(w, 'pt3_rev', '7I')['cgst']).toBe(500);
    expect(row(w, 'pt3_rev', '7J')['cgst']).toBe(2_500);
  });

  it('computes 8D as 8A less 8B', () => {
    expect(row(w, 'pt3_other', '8A')['cgst']).toBe(3_000);
    expect(row(w, 'pt3_other', '8D')['cgst']).toBe(0);
  });

  it('takes tax payable from GSTR-3B 3.1 plus reverse charge, and leaves paid unknown', () => {
    expect(row(w, 'pt4_tax', '9A')['payable']).toBe(3_600);
    expect(row(w, 'pt4_tax', '9B')['payable']).toBe(12_600 + 2_700);
    expect(row(w, 'pt4_tax', '9C')['payable']).toBe(12_600 + 2_700);
    expect(row(w, 'pt4_tax', '9B')['paid']).toBeNull();
    expect(row(w, 'pt4_tax', '9B')['diff']).toBeNull();
  });

  it('fills paid and the difference from a ledger summary', () => {
    const paid = (cash: number, itc = 0) => ({ cash, itc });
    const z = paid(0);
    const withLedger = buildGstr9(
      input({
        ledger: {
          coveredMonths: ['2026-11'],
          missingKinds: [],
          paid: { igst: paid(3_600), cgst: paid(10_000, 5_300), sgst: paid(10_000, 5_300), cess: z, interest: z, lateFee: z, penalty: z, other: z },
          itcReclaimed: ZERO_TAX,
          itcReversed: ZERO_TAX,
          unclassifiedEntries: 0,
        },
      }),
    );
    expect(row(withLedger, 'pt4_tax', '9B')['paid']).toBe(15_300);
    expect(row(withLedger, 'pt4_tax', '9B')['diff']).toBe(0);
    expect(codes(withLedger)).not.toContain('ledger_not_imported');
  });
});

describe('GSTR-9 with ledgers but no checked classification rule', () => {
  const ledger = {
    coveredMonths: ['2026-11'],
    missingKinds: [],
    paid: null,
    itcReclaimed: { igst: 0, cgst: 700, sgst: 700, cess: 0 },
    itcReversed: ZERO_TAX,
    unclassifiedEntries: 0,
  } as const;

  it('takes 6H from the credit reversal ledger but leaves paid unknown', () => {
    const w = buildGstr9(input({ ledger }));
    expect(row(w, 'pt3_itc', '6H')['cgst']).toBe(700);
    expect(row(w, 'pt3_itc', '6I')['cgst']).toBe(3_000 + 700);
    expect(row(w, 'pt4_tax', '9B')['paid']).toBeNull();
    expect(codes(w)).toContain('ledger_paid_not_classified');
    expect(codes(w)).not.toContain('ledger_not_imported');
  });

  it('names the ledgers that were not imported and the months they miss', () => {
    const w = buildGstr9(
      input({
        periods: [period(), period({ label: 'Dec 2026', from: '2026-12-01', to: '2026-12-31' })],
        ledger: { ...ledger, missingKinds: ['cash'] },
      }),
    );
    expect(codes(w)).toContain('ledger_kind_missing');
    expect(w.issues.find((i) => i.code === 'ledger_months_missing')?.message).toContain('2026-12');
  });
});

describe('GSTR-9 checks and issues', () => {
  it('has no reconciliation warning when the returns agree with each other and the books', () => {
    const w = buildGstr9(input());
    expect(codes(w)).not.toContain('gstr1_gstr3b_differ');
    expect(codes(w)).not.toContain('returns_differ_from_books');
    expect(codes(w)).not.toContain('itc_register_differs_from_3b');
  });

  it('warns when GSTR-3B disagrees with GSTR-1', () => {
    const bad = gstr3b();
    const w = buildGstr9(
      input({
        periods: [
          period({
            gstr3b: { ...bad, outward: { ...bad.outward, taxable: tv(140_000, { cgst: 12_600, sgst: 12_600 }) } },
          }),
        ],
      }),
    );
    expect(codes(w)).toContain('gstr1_gstr3b_differ');
  });

  it('warns when the books moved after the returns were prepared', () => {
    const w = buildGstr9(input({ books: { outwardTaxable: 180_000, outwardTax: 28_800 } }));
    expect(codes(w)).toContain('returns_differ_from_books');
  });

  it('warns when the register and GSTR-3B credit differ (6J)', () => {
    const w = buildGstr9(input({ itc: buildItcBreakdown([]) }));
    expect(codes(w)).toContain('itc_register_differs_from_3b');
    expect(row(w, 'pt3_itc', '6J')['cgst']).toBe(-3_000);
  });

  it('names periods that were never prepared', () => {
    const w = buildGstr9(input({ periods: [period({ source: 'live', note: 'GSTR-1 was not prepared.' })] }));
    expect(w.issues.find((i) => i.code === 'period_not_prepared')?.message).toContain('Nov 2026');
    expect(sheet(w, 'coverage').rows[0]?.['source']).toBe('Worked out now from the books');
  });

  it('says what it cannot compute and that tax paid is unknown', () => {
    const w = buildGstr9(input());
    expect(codes(w)).toEqual(
      expect.arrayContaining(['ledger_not_imported', 'advances_not_computed', 'tables_10_16_not_computed', 'reversal_rules_not_split']),
    );
  });

  it('reports 2B months that were not imported', () => {
    const w = buildGstr9(input({ twoB: { monthsImported: 0, monthsExpected: 12, total: ZERO_TAX } }));
    expect(w.issues.find((i) => i.code === 'gstr2b_months_missing')?.count).toBe(12);
  });
});

describe('GSTR-9 Tables 17 and 18', () => {
  it('sums outward HSN across both buckets', () => {
    const w = buildGstr9(input());
    const rows = sheet(w, 'hsn_out').rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['taxable']).toBe(160_000);
    expect(rows[0]?.['quantity']).toBe(4_000);
  });
});

describe('credit register routing', () => {
  const base = {
    reverseCharge: false,
    supplierRegistered: true,
    importGoods: false,
    foreignSupplier: false,
    tax: { igst: 100, cgst: 0, sgst: 0, cess: 0 },
    rows: 1,
  } as const;

  it('puts credit in the row its nature decides', () => {
    const b = buildItcBreakdown([
      { ...base, category: 'inputs' },
      { ...base, category: 'capital_goods' },
      { ...base, category: 'input_services', reverseCharge: true, supplierRegistered: false },
      { ...base, category: 'inputs', reverseCharge: true },
      { ...base, category: 'inputs', importGoods: true },
      { ...base, category: 'input_services', foreignSupplier: true, reverseCharge: true },
    ]);
    expect(b.nonReverseCharge.ip.igst).toBe(100);
    expect(b.nonReverseCharge.cg.igst).toBe(100);
    expect(b.reverseChargeUnregistered.is.igst).toBe(100);
    expect(b.reverseChargeRegistered.ip.igst).toBe(100);
    expect(b.importGoods.ip.igst).toBe(100);
    expect(b.importServices.igst).toBe(100);
  });

  it('counts ineligible credit as inputs and says the type was assumed', () => {
    const b = buildItcBreakdown([{ ...base, category: 'ineligible', rows: 3 }]);
    expect(b.nonReverseCharge.ip.igst).toBe(100);
    expect(b.ineligibleTypeAssumed).toBe(3);
  });
});

describe('monthsIn', () => {
  it('lists the months of a financial year', () => {
    const m = monthsIn('2026-04-01', '2027-03-31');
    expect(m).toHaveLength(12);
    expect(m[0]).toBe('2026-04');
    expect(m[11]).toBe('2027-03');
  });
});

describe('GSTR-9 portal file', () => {
  const model = buildGstr9(input()).model;
  const out = exportPayload('gstr9', model, { year: 2026, month: 3 });

  it('validates against the official Save schema and is labelled a draft', () => {
    expect(out.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(out.portalReady).toBe(false);
    expect(out.status).toBe('draft');
    expect(out.verification).toBe('schema_checked_mapping_unverified');
  });

  it('writes the period as the financial year', () => {
    expect(out.payload['fp']).toBe('032027');
    expect(out.payload['gstin']).toBe('27AAACG1395D1ZU');
  });

  it('writes rupees, not paise, and places rows under the right keys', () => {
    const t4 = out.payload['table4'] as Record<string, Record<string, number>>;
    expect(t4['b2b']?.['txval']).toBe(1000);
    expect(t4['b2b']?.['camt']).toBe(90);
    expect(t4['exp']?.['iamt']).toBe(36);
    const t5 = out.payload['table5'] as Record<string, Record<string, number>>;
    expect(t5['rchrg']?.['txval']).toBe(100);
  });

  it('leaves out rows it does not compute rather than writing zeros', () => {
    const t4 = out.payload['table4'] as Record<string, unknown>;
    for (const key of ['at', 'ecom', 'amd_pos', 'amd_neg']) expect(t4[key]).toBeUndefined();
    expect(out.payload['table8']).toBeUndefined();
    expect(out.payload['table10']).toBeUndefined();
    const warnings = out.issues.map((i) => i.code);
    expect(warnings).toEqual(expect.arrayContaining(['table8_not_written', 'tables_10_16_not_written']));
  });

  it('omits paid and difference when the ledgers are unknown', () => {
    const t9 = out.payload['table9'] as Record<string, Record<string, number>>;
    expect(t9['camt']).toEqual({ txpyble: 153 });
  });

  it('writes the HSN tables, with quantity and unit for goods', () => {
    const t17 = out.payload['table17'] as { items: Record<string, unknown>[] };
    expect(t17.items[0]).toMatchObject({ hsn_sc: '6109', uqc: 'PCS', qty: 4, rt: 18, isconcesstional: 'N' });
  });

  it('refuses an HSN code the portal cannot take', () => {
    const bad = {
      ...model,
      hsnOutward: [{ hsn: 'NA', uqc: 'OTH', quantity: 0, ratePercent: 18, value: tv(100) }],
    };
    const res = exportPayload('gstr9', bad, { year: 2026, month: 3 });
    expect(res.issues.some((i) => i.code === 'hsn_code_invalid')).toBe(true);
    expect(res.status).toBe('refused');
  });
});
