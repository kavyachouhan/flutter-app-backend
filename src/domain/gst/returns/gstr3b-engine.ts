/**
 * GSTR-3B engine: outward figures come from the same net totals as GSTR-1 (so the two returns
 * cannot drift), inward figures and credit from the purchase side. Pure.
 *
 * Table 4 follows the way the portal pre-fills it: 4(A) is all credit per the books, including
 * bills later found ineligible, and the ineligible part is taken out through 4(B). That keeps 4(A)
 * comparable with the GSTR-2B totals.
 */
import type { Gstr1Net } from './gstr1-engine.js';
import {
  ZERO_TAXED,
  type Gstr3bReturn,
  type ItcAvailableKind,
  type ItcIneligibleKind,
  type ItcReversedKind,
  type PlaceOfSupplyRow,
  type ReturnPeriod,
  type TaxAmounts,
  type TaxedValue,
} from './model.js';
import { col, makeSheet, type Sheet, type SummaryLine, type WorkingIssue } from './sheets.js';

export interface Gstr3bInput {
  readonly gstin: string;
  readonly period: ReturnPeriod;
  readonly gstr1: Gstr1Net;
  /** Inward supplies liable to reverse charge: value and self-assessed tax by head. */
  readonly inwardReverseCharge: TaxedValue;
  readonly itc: {
    readonly available: Readonly<Record<ItcAvailableKind, TaxAmounts>>;
    readonly reversed: Readonly<Record<ItcReversedKind, TaxAmounts>>;
    readonly ineligible: Readonly<Record<ItcIneligibleKind, TaxAmounts>>;
  };
  readonly inwardExempt: {
    readonly gst: { readonly interState: number; readonly intraState: number };
    readonly nonGst: { readonly interState: number; readonly intraState: number };
  };
  /** Count of outward documents under reverse charge, which this engine cannot place with certainty. */
  readonly outwardReverseChargeDocs: number;
  readonly pendingItcRows: number;
}

export interface Gstr3bWorkings {
  readonly form: 'gstr3b';
  readonly gstin: string;
  readonly period: ReturnPeriod;
  readonly sheets: readonly Sheet[];
  readonly summary: readonly SummaryLine[];
  readonly issues: readonly WorkingIssue[];
  readonly totals: { readonly taxable: number; readonly tax: number };
  readonly model: Gstr3bReturn;
}

const sumTax = (list: readonly TaxAmounts[]): TaxAmounts => ({
  igst: list.reduce((s, t) => s + t.igst, 0),
  cgst: list.reduce((s, t) => s + t.cgst, 0),
  sgst: list.reduce((s, t) => s + t.sgst, 0),
  cess: list.reduce((s, t) => s + t.cess, 0),
});

const posRows = (m: ReadonlyMap<string, { taxable: number; igst: number }>): PlaceOfSupplyRow[] =>
  [...m.entries()]
    .filter(([, v]) => v.taxable !== 0 || v.igst !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([placeOfSupply, v]) => ({ placeOfSupply, taxable: v.taxable, igst: v.igst }));

const AVAILABLE_LABEL: Readonly<Record<ItcAvailableKind, string>> = {
  import_goods: '(1) Import of goods',
  import_services: '(2) Import of services',
  reverse_charge: '(3) Inward supplies liable to reverse charge (other than 1 & 2 above)',
  isd: '(4) Inward supplies from ISD',
  other: '(5) All other ITC',
};
const REVERSED_LABEL: Readonly<Record<ItcReversedKind, string>> = {
  rules_38_42_43_17_5: '(1) As per rules 38, 42 & 43 of CGST Rules and section 17(5)',
  other: '(2) Others',
};
const INELIGIBLE_LABEL: Readonly<Record<ItcIneligibleKind, string>> = {
  reclaimed_after_reversal: '(1) ITC reclaimed which was reversed under 4(B)(2) earlier',
  section_16_4_or_pos: '(2) Ineligible ITC under section 16(4) and ITC restricted due to PoS',
};

export function buildGstr3b(input: Gstr3bInput): Gstr3bWorkings {
  const issues: WorkingIssue[] = [];
  const g = input.gstr1;

  const model: Gstr3bReturn = {
    gstin: input.gstin,
    period: input.period,
    outward: {
      taxable: g.taxable,
      zeroRated: { taxable: g.zeroRated.taxable, igst: g.zeroRated.igst, cess: g.zeroRated.cess },
      nilExempt: g.nilExempt,
      inwardReverseCharge: input.inwardReverseCharge,
      nonGst: g.nonGst,
    },
    interState: {
      unregistered: posRows(g.interState.unregistered),
      composition: posRows(g.interState.composition),
      uin: posRows(g.interState.uin),
    },
    itc: input.itc,
    inwardExempt: input.inwardExempt,
  };

  if (input.outwardReverseChargeDocs > 0) {
    issues.push({
      severity: 'warning',
      code: 'outward_reverse_charge_unplaced',
      count: input.outwardReverseChargeDocs,
      message: `${input.outwardReverseChargeDocs} outward document(s) are under reverse charge. Their placement in 3.1 is not built from an official rule yet; check them manually.`,
    });
  }
  if (g.zeroRated.cgst !== 0 || g.zeroRated.sgst !== 0) {
    issues.push({
      severity: 'error',
      code: 'zero_rated_with_cgst_sgst',
      message:
        'Zero-rated supplies carry CGST/SGST; the portal accepts only IGST and cess in 3.1(b).',
    });
  }
  if (input.pendingItcRows > 0) {
    issues.push({
      severity: 'info',
      code: 'itc_pending_conditions',
      count: input.pendingItcRows,
      message: `${input.pendingItcRows} purchase bill(s) have credit with conditions still open (payment within 180 days, goods received); review before claiming.`,
    });
  }
  issues.push({
    severity: 'info',
    code: 'interest_late_fee_manual',
    message:
      'Interest, late fee (5.1) and payment of tax (6) are not computed here: they depend on due dates and the electronic ledgers held by GSTN.',
  });

  const a = sumTax(Object.values(input.itc.available));
  const r = sumTax(Object.values(input.itc.reversed));
  const net: TaxAmounts = {
    igst: a.igst - r.igst,
    cgst: a.cgst - r.cgst,
    sgst: a.sgst - r.sgst,
    cess: a.cess - r.cess,
  };

  const taxedRow = (key: string, label: string, v: TaxedValue) => ({
    key,
    label,
    taxable: v.taxable,
    igst: v.igst,
    cgst: v.cgst,
    sgst: v.sgst,
    cess: v.cess,
  });
  const taxCols = [
    col('label', 'Nature of supplies'),
    col('taxable', 'Total taxable value', 'money', true),
    col('igst', 'Integrated Tax', 'money', true),
    col('cgst', 'Central Tax', 'money', true),
    col('sgst', 'State/UT Tax', 'money', true),
    col('cess', 'Cess', 'money', true),
  ];

  const z = ZERO_TAXED;
  const sheets: Sheet[] = [
    makeSheet(
      '3_1',
      'Outward supplies and inward supplies liable to reverse charge',
      taxCols,
      [
        taxedRow(
          'a',
          '(a) Outward taxable supplies (other than zero rated, nil rated and exempted)',
          g.taxable,
        ),
        taxedRow('b', '(b) Outward taxable supplies (zero rated)', {
          ...z,
          taxable: g.zeroRated.taxable,
          igst: g.zeroRated.igst,
          cess: g.zeroRated.cess,
        }),
        taxedRow('c', '(c) Other outward supplies (nil rated, exempted)', {
          ...z,
          taxable: g.nilExempt,
        }),
        taxedRow('d', '(d) Inward supplies (liable to reverse charge)', input.inwardReverseCharge),
        taxedRow('e', '(e) Non-GST outward supplies', { ...z, taxable: g.nonGst }),
      ],
      { table: '3.1' },
    ),
    makeSheet(
      '3_2',
      'Inter-state supplies to unregistered, composition and UIN holders',
      [
        col('recipient', 'Recipient'),
        col('pos', 'Place of Supply (State/UT)'),
        col('taxable', 'Total Taxable Value', 'money', true),
        col('igst', 'Amount of Integrated Tax', 'money', true),
      ],
      [
        ...model.interState.unregistered.map((x) => ({
          recipient: 'Unregistered persons',
          pos: x.placeOfSupply,
          taxable: x.taxable,
          igst: x.igst,
        })),
        ...model.interState.composition.map((x) => ({
          recipient: 'Composition taxable persons',
          pos: x.placeOfSupply,
          taxable: x.taxable,
          igst: x.igst,
        })),
        ...model.interState.uin.map((x) => ({
          recipient: 'UIN holders',
          pos: x.placeOfSupply,
          taxable: x.taxable,
          igst: x.igst,
        })),
      ],
      { table: '3.2' },
    ),
    makeSheet(
      '4',
      'Eligible input tax credit',
      [
        col('label', 'Details'),
        col('igst', 'Integrated Tax', 'money'),
        col('cgst', 'Central Tax', 'money'),
        col('sgst', 'State/UT Tax', 'money'),
        col('cess', 'Cess', 'money'),
      ],
      [
        {
          label: '(A) ITC Available (whether in full or part)',
          igst: null,
          cgst: null,
          sgst: null,
          cess: null,
        },
        ...(Object.keys(AVAILABLE_LABEL) as ItcAvailableKind[]).map((k) => ({
          label: AVAILABLE_LABEL[k],
          ...input.itc.available[k],
        })),
        { label: '(B) ITC Reversed', igst: null, cgst: null, sgst: null, cess: null },
        ...(Object.keys(REVERSED_LABEL) as ItcReversedKind[]).map((k) => ({
          label: REVERSED_LABEL[k],
          ...input.itc.reversed[k],
        })),
        { label: '(C) Net ITC Available (A) - (B)', ...net },
        { label: '(D) Other details', igst: null, cgst: null, sgst: null, cess: null },
        ...(Object.keys(INELIGIBLE_LABEL) as ItcIneligibleKind[]).map((k) => ({
          label: INELIGIBLE_LABEL[k],
          ...input.itc.ineligible[k],
        })),
      ],
      { table: '4' },
    ),
    makeSheet(
      '5',
      'Exempt, nil-rated and non-GST inward supplies',
      [
        col('label', 'Nature of supplies'),
        col('inter', 'Inter-State supplies', 'money', true),
        col('intra', 'Intra-State supplies', 'money', true),
      ],
      [
        {
          label: 'From a supplier under composition scheme, Exempt and Nil rated supply',
          inter: input.inwardExempt.gst.interState,
          intra: input.inwardExempt.gst.intraState,
        },
        {
          label: 'Non GST supply',
          inter: input.inwardExempt.nonGst.interState,
          intra: input.inwardExempt.nonGst.intraState,
        },
      ],
      { table: '5' },
    ),
  ];

  const outwardTax =
    g.taxable.igst +
    g.taxable.cgst +
    g.taxable.sgst +
    g.taxable.cess +
    g.zeroRated.igst +
    g.zeroRated.cess;
  const rcmTax =
    input.inwardReverseCharge.igst +
    input.inwardReverseCharge.cgst +
    input.inwardReverseCharge.sgst +
    input.inwardReverseCharge.cess;

  const summary: SummaryLine[] = [
    {
      key: 'outward',
      label: '3.1 Outward supplies',
      records: 0,
      taxable: g.taxable.taxable + g.zeroRated.taxable,
      igst: g.taxable.igst + g.zeroRated.igst,
      cgst: g.taxable.cgst,
      sgst: g.taxable.sgst,
      cess: g.taxable.cess + g.zeroRated.cess,
      value: 0,
    },
    {
      key: 'rcm',
      label: '3.1(d) Reverse charge',
      records: 0,
      taxable: input.inwardReverseCharge.taxable,
      igst: input.inwardReverseCharge.igst,
      cgst: input.inwardReverseCharge.cgst,
      sgst: input.inwardReverseCharge.sgst,
      cess: input.inwardReverseCharge.cess,
      value: 0,
    },
    {
      key: 'itc_net',
      label: '4(C) Net ITC',
      records: 0,
      taxable: 0,
      igst: net.igst,
      cgst: net.cgst,
      sgst: net.sgst,
      cess: net.cess,
      value: 0,
    },
  ];

  return {
    form: 'gstr3b',
    gstin: input.gstin,
    period: input.period,
    sheets,
    summary,
    issues,
    totals: {
      taxable: g.taxable.taxable + g.zeroRated.taxable + input.inwardReverseCharge.taxable,
      tax: outwardTax + rcmTax,
    },
    model,
  };
}
