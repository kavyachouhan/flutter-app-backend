/**
 * Composition returns (s.10, s.39(2), Rule 62). Pure.
 *
 *   CMP-08 (quarterly statement-cum-challan), Table 3 as substituted by 05/2026-CT (01.11.2026):
 *     1     outward supplies of goods (including exempt supplies)
 *     1(a)  outward supplies of services (including exempt), excluding services through an
 *           e-commerce operator liable under s.9(5)
 *     1(b)  services through an operator liable under s.9(5): no tax for the composition dealer,
 *           but counted in turnover (instruction 3C)
 *     2     inward supplies attracting reverse charge, including import of services
 *     3     tax payable = 1 + 1(a) + 2; 4 interest; 5 paid
 *   GSTR-4 (annual): Table 4 inward supplies (registered, reverse charge, unregistered, import of
 *   services), Table 5 the quarters' CMP-08 figures, Table 6 outward supplies by rate.
 *
 * Tax on outward supplies is the composition rate on turnover (Rule 7), split equally between
 * CGST and SGST. A trader pays on taxable supplies only; a manufacturer, restaurant or s.10(2A)
 * service provider pays on turnover in the State including exempt supplies. Non-GST supplies are
 * not counted. Services are told from goods by a SAC (HSN chapter 99).
 */
import type { EngineDoc } from './gstr1-engine.js';
import type { TaxedValue } from './model.js';
import { col, makeSheet, type Sheet, type WorkingIssue } from './sheets.js';

export type CompositionCategory = 'trader' | 'manufacturer' | 'restaurant' | 'service';

export interface CompositionTurnover {
  readonly goods: number;
  readonly services: number;
  readonly servicesViaEco95: number;
}

export interface Cmp08Figures {
  readonly turnover: CompositionTurnover;
  readonly outwardTax: TaxedValue; // on 1 + 1(a)
  readonly inwardReverseCharge: TaxedValue; // row 2
  readonly payable: TaxedValue; // row 3
}

const ZERO: TaxedValue = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
const addV = (a: TaxedValue, b: TaxedValue): TaxedValue => ({
  taxable: a.taxable + b.taxable,
  igst: a.igst + b.igst,
  cgst: a.cgst + b.cgst,
  sgst: a.sgst + b.sgst,
  cess: a.cess + b.cess,
});
const isService = (hsn: string | null) => (hsn ?? '').startsWith('99');

/** Turnover of the period by row, net of credit notes. */
export function compositionTurnover(
  docs: readonly EngineDoc[],
  category: CompositionCategory,
): CompositionTurnover {
  let goods = 0;
  let services = 0;
  let servicesViaEco95 = 0;
  for (const d of docs) {
    if (d.status !== 'issued') continue;
    const sign = d.kind === 'credit_note' ? -1 : 1;
    const viaEco95 = d.ecoLiability === 's9_5';
    for (const l of d.lines) {
      if (l.category === 'non_gst') continue;
      if (category === 'trader' && l.category !== 'taxable') continue;
      const v = sign * l.taxable;
      if (isService(l.hsn)) {
        if (viaEco95) servicesViaEco95 += v;
        else services += v;
      } else goods += v;
    }
  }
  return { goods, services, servicesViaEco95 };
}

export function cmp08Figures(
  turnover: CompositionTurnover,
  ratePercent: number,
  inwardReverseCharge: TaxedValue,
): Cmp08Figures {
  const base = turnover.goods + turnover.services;
  const half = Math.round((base * ratePercent) / 200);
  const outwardTax: TaxedValue = { taxable: base, igst: 0, cgst: half, sgst: half, cess: 0 };
  return {
    turnover,
    outwardTax,
    inwardReverseCharge,
    payable: addV({ ...outwardTax, taxable: 0 }, { ...inwardReverseCharge, taxable: 0 }),
  };
}

const money = (k: string, l: string) => col(k, l, 'money', true);

export function cmp08Sheet(f: Cmp08Figures, ratePercent: number): Sheet {
  const share = (value: number) => {
    const half = Math.round((value * ratePercent) / 200);
    return { igst: 0, cgst: half, sgst: half, cess: 0 };
  };
  const rows = [
    { ref: '1', label: 'Outward supplies of goods (including exempt supplies)', value: f.turnover.goods, ...share(f.turnover.goods) },
    {
      ref: '1(a)',
      label: 'Outward supplies of services (including exempt), excluding services through an e-commerce operator liable under s.9(5)',
      value: f.turnover.services,
      ...share(f.turnover.services),
    },
    {
      ref: '1(b)',
      label: 'Outward supplies of services through an e-commerce operator liable to pay tax under s.9(5)',
      value: f.turnover.servicesViaEco95,
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
    },
    {
      ref: '2',
      label: 'Inward supplies attracting reverse charge including import of services',
      value: f.inwardReverseCharge.taxable,
      igst: f.inwardReverseCharge.igst,
      cgst: f.inwardReverseCharge.cgst,
      sgst: f.inwardReverseCharge.sgst,
      cess: f.inwardReverseCharge.cess,
    },
    {
      ref: '3',
      label: 'Tax payable (1 + 1(a) + 2)',
      value: null,
      igst: f.payable.igst,
      cgst: f.payable.cgst,
      sgst: f.payable.sgst,
      cess: f.payable.cess,
    },
  ];
  return makeSheet(
    'cmp08_t3',
    'Summary of self-assessed liability (Table 3)',
    [col('ref', 'Sl.'), col('label', 'Description'), col('value', 'Value', 'money'), money('igst', 'Integrated tax'), money('cgst', 'Central tax'), money('sgst', 'State/UT tax'), money('cess', 'Cess')],
    rows,
    {
      note: `Composition rate ${ratePercent}% on turnover, split equally between central and State tax. Row 1(b) is counted in turnover but carries no tax (CMP-08 instruction 3C, 05/2026-CT). Interest (row 4) is not computed.`,
    },
  );
}

export interface InwardDocument {
  readonly supplierGstin: string | null;
  readonly supplierName: string | null;
  readonly number: string;
  readonly date: string;
  readonly reverseCharge: boolean;
  readonly importOfServices: boolean;
  readonly placeOfSupply: string | null;
  readonly ratePercent: number;
  readonly value: TaxedValue;
}

/** GSTR-4 Table 4: inward supplies, invoice-wise (Rule 62(3)(a)). */
export function gstr4InwardSheet(docs: readonly InwardDocument[]): Sheet {
  const table = (d: InwardDocument) =>
    d.importOfServices ? '4D Import of services' : !d.supplierGstin ? '4C Unregistered supplier' : d.reverseCharge ? '4B Registered, reverse charge' : '4A Registered supplier';
  return makeSheet(
    'gstr4_t4',
    'Inward supplies (Table 4)',
    [col('table', 'Table'), col('gstin', 'Supplier GSTIN'), col('name', 'Supplier'), col('number', 'Invoice'), col('date', 'Date', 'date'), col('pos', 'Place of supply'), col('rate', 'Rate'), money('taxable', 'Taxable value'), money('igst', 'Integrated tax'), money('cgst', 'Central tax'), money('sgst', 'State/UT tax'), money('cess', 'Cess')],
    docs.map((d) => ({
      table: table(d),
      gstin: d.supplierGstin,
      name: d.supplierName,
      number: d.number,
      date: d.date,
      pos: d.placeOfSupply,
      rate: d.ratePercent,
      taxable: d.value.taxable,
      igst: d.value.igst,
      cgst: d.value.cgst,
      sgst: d.value.sgst,
      cess: d.value.cess,
    })),
  );
}

export interface QuarterFigures {
  readonly quarter: string; // e.g. "Apr-Jun 2026"
  readonly figures: Cmp08Figures;
}

/** GSTR-4 Table 5 (the quarters' CMP-08 figures) and Table 6 (outward supplies by rate). */
export function gstr4SummarySheets(quarters: readonly QuarterFigures[], ratePercent: number): Sheet[] {
  const t5 = makeSheet(
    'gstr4_t5',
    'Self-assessed liability as declared in CMP-08 (Table 5)',
    [col('quarter', 'Quarter'), money('turnover', 'Outward supplies'), money('eco95', 'Of which via operator u/s 9(5)'), money('rcm', 'Inward reverse charge'), money('igst', 'Integrated tax'), money('cgst', 'Central tax'), money('sgst', 'State/UT tax'), money('cess', 'Cess')],
    quarters.map((q) => ({
      quarter: q.quarter,
      turnover: q.figures.turnover.goods + q.figures.turnover.services + q.figures.turnover.servicesViaEco95,
      eco95: q.figures.turnover.servicesViaEco95,
      rcm: q.figures.inwardReverseCharge.taxable,
      igst: q.figures.payable.igst,
      cgst: q.figures.payable.cgst,
      sgst: q.figures.payable.sgst,
      cess: q.figures.payable.cess,
    })),
  );
  const year = quarters.reduce(
    (s, q) => ({
      goods: s.goods + q.figures.turnover.goods,
      services: s.services + q.figures.turnover.services,
      eco: s.eco + q.figures.turnover.servicesViaEco95,
    }),
    { goods: 0, services: 0, eco: 0 },
  );
  const base = year.goods + year.services;
  const half = Math.round((base * ratePercent) / 200);
  const t6 = makeSheet(
    'gstr4_t6',
    'Outward supplies by rate (Table 6)',
    [col('rate', 'Rate of tax'), money('taxable', 'Total value'), money('cgst', 'Central tax'), money('sgst', 'State/UT tax')],
    [
      { rate: ratePercent, taxable: base, cgst: half, sgst: half },
      ...(year.eco !== 0 ? [{ rate: 0, taxable: year.eco, cgst: 0, sgst: 0 }] : []),
    ],
    { note: 'Services supplied through an e-commerce operator liable under s.9(5) are shown at no tax.' },
  );
  return [t5, t6];
}

export const COMPOSITION_ISSUES: readonly WorkingIssue[] = [
  {
    severity: 'info',
    code: 'composition_no_file',
    message:
      'No offline tool for the annual GSTR-4 or for CMP-08 is published (the GSTR-4 utility v3.3 is for the old quarterly form). Enter these figures on the portal; they are exported as Excel and CA package.',
  },
];

export const ZERO_VALUE = ZERO;
