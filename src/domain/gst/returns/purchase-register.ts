/**
 * Purchase register in the layout of the official GSTR-2 offline template.
 *
 * GSTR-2 itself has been suspended since 2017, so this is a register an accountant can read and
 * reconcile against GSTR-2B, not a filing: there is no portal JSON for it. Column labels are the
 * ones in `data/gst_returns_offline_tool/Section_wise_CSV_files/GSTR2`.
 *
 * Pure. Classification is per line, as in the GSTR-1 engine: one bill can carry taxable, exempt
 * and non-GST lines, and only the taxable ones belong in the rate-wise tables.
 */
import { STATE_NAMES } from '../../print/states.js';
import type { SupplyCategory } from '../classify.js';
import { col, makeSheet, type Sheet, type SheetCell, type WorkingIssue } from './sheets.js';

export type ItcCategory = 'inputs' | 'input_services' | 'capital_goods' | 'ineligible';

export interface InwardLine {
  readonly category: SupplyCategory;
  readonly hsn: string | null;
  readonly unit: string | null;
  /** Thousandths of a unit. */
  readonly quantity: number;
  readonly taxable: number;
  readonly ratePercent: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
}

export interface InwardDoc {
  readonly kind: 'bill' | 'debit_note';
  readonly id: string;
  /** Supplier's invoice number for a bill; our own number for a debit note. */
  readonly number: string;
  readonly date: string;
  readonly grandTotal: number;
  readonly supplierName: string | null;
  readonly supplierGstin: string | null;
  readonly supplierCountry: string;
  readonly supplierTreatment: string | null;
  readonly composition: boolean;
  readonly placeOfSupply: string | null;
  readonly interState: boolean;
  readonly reverseCharge: boolean;
  readonly itcCategory: ItcCategory | null;
  readonly itcEligible: boolean;
  readonly boeNumber: string | null;
  readonly boeDate: string | null;
  readonly boePortCode: string | null;
  /** Debit notes: the bill being corrected and why. */
  readonly original: { readonly number: string; readonly date: string } | null;
  readonly reasonCode: string | null;
  /** Credit per the ITC register for this document (signed), for the cross-check. */
  readonly registerItc: number | null;
  readonly lines: readonly InwardLine[];
}

export interface PurchaseRegisterInput {
  readonly docs: readonly InwardDoc[];
  /** false = "don't consider non tax transactions": documents with no taxable line are left out. */
  readonly includeNonTax: boolean;
}

export interface PurchaseRegister {
  readonly sheets: readonly Sheet[];
  readonly issues: readonly WorkingIssue[];
  /** Net taxable value, tax and availed ITC of the rows shown, in paise. */
  readonly totals: { readonly taxable: number; readonly tax: number; readonly itc: number };
}

const ITC_LABEL: Readonly<Record<ItcCategory, string>> = {
  inputs: 'Inputs',
  input_services: 'Input services',
  capital_goods: 'Capital goods',
  ineligible: 'Ineligible',
};

/** GSTR-2 note reasons. Our debit-note reasons are coarser; the mapping is deliberate and listed. */
const NOTE_REASON: Readonly<Record<string, string>> = {
  return: '01-Sales Return',
  damaged: '01-Sales Return',
  quality: '01-Sales Return',
  expired: '01-Sales Return',
  short_supply: '01-Sales Return',
  rate_difference: '04-Correction in Invoice',
  other: '07-Others',
};

const posLabel = (pos: string | null): string =>
  pos ? `${pos}-${STATE_NAMES[pos] ?? 'Unknown'}` : '';

interface Heads {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}
const zero = (): Heads => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

function byRate(lines: readonly InwardLine[]): [number, Heads][] {
  const m = new Map<number, Heads>();
  for (const l of lines) {
    const h = m.get(l.ratePercent) ?? zero();
    h.taxable += l.taxable;
    h.igst += l.igst;
    h.cgst += l.cgst;
    h.sgst += l.sgst;
    h.cess += l.cess;
    m.set(l.ratePercent, h);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

export function buildPurchaseRegister(input: PurchaseRegisterInput): PurchaseRegister {
  const issues: WorkingIssue[] = [];
  const rows = {
    b2b: [] as Record<string, SheetCell>[],
    b2bur: [] as Record<string, SheetCell>[],
    imps: [] as Record<string, SheetCell>[],
    impg: [] as Record<string, SheetCell>[],
    cdnr: [] as Record<string, SheetCell>[],
    cdnur: [] as Record<string, SheetCell>[],
  };
  const exemp = {
    inter: { composition: 0, nil: 0, exempt: 0, nonGst: 0 },
    intra: { composition: 0, nil: 0, exempt: 0, nonGst: 0 },
  };
  const hsn = new Map<string, { hsn: string; uqc: string; qty: number; value: Heads }>();

  let skippedNonTax = 0;
  let missingPos = 0;
  let missingHsn = 0;
  let engineItc = 0;
  let registerItc = 0;
  let registerKnown = 0;
  const totals = { taxable: 0, tax: 0, itc: 0 };

  for (const d of input.docs) {
    const sign = d.kind === 'debit_note' ? -1 : 1;
    // Composition suppliers charge no tax, so nothing of theirs is taxable or creditable.
    const taxableLines = d.composition ? [] : d.lines.filter((l) => l.category === 'taxable');
    const otherLines = d.composition ? d.lines : d.lines.filter((l) => l.category !== 'taxable');

    if (taxableLines.length === 0 && !input.includeNonTax) {
      skippedNonTax++;
      continue;
    }

    // HSN summary: every line, net of debit notes.
    for (const l of d.lines) {
      if (!l.hsn) missingHsn++;
      const key = `${l.hsn ?? 'NA'}|${l.unit ?? 'OTH'}`;
      const cur = hsn.get(key) ?? { hsn: l.hsn ?? 'NA', uqc: l.unit ?? 'OTH', qty: 0, value: zero() };
      cur.qty += sign * l.quantity;
      cur.value.taxable += sign * l.taxable;
      cur.value.igst += sign * l.igst;
      cur.value.cgst += sign * l.cgst;
      cur.value.sgst += sign * l.sgst;
      cur.value.cess += sign * l.cess;
      hsn.set(key, cur);
    }

    // Table 5 style buckets.
    if (otherLines.length > 0 && input.includeNonTax) {
      const bucket = d.interState ? exemp.inter : exemp.intra;
      for (const l of otherLines) {
        if (d.composition) bucket.composition += sign * l.taxable;
        else if (l.category === 'nil_rated') bucket.nil += sign * l.taxable;
        else if (l.category === 'exempt') bucket.exempt += sign * l.taxable;
        else bucket.nonGst += sign * l.taxable;
      }
    }

    if (taxableLines.length === 0) continue;

    if (!d.placeOfSupply) missingPos++;
    const eligible = d.itcEligible && d.itcCategory !== null && d.itcCategory !== 'ineligible';
    const eligibility = ITC_LABEL[d.itcCategory ?? 'ineligible'];
    const foreign = d.supplierCountry !== 'IN';
    const imported = d.boeNumber !== null;
    const supply = d.interState ? 'Inter State' : 'Intra State';
    const pos = posLabel(d.placeOfSupply);

    if (d.registerItc !== null) {
      registerKnown++;
      registerItc += d.registerItc;
    }
    const itcOf = (h: Heads, key: 'igst' | 'cgst' | 'sgst' | 'cess') => (eligible ? h[key] : 0);

    for (const [rate, h] of byRate(taxableLines)) {
      const tax = h.igst + h.cgst + h.sgst + h.cess;
      const itc = itcOf(h, 'igst') + itcOf(h, 'cgst') + itcOf(h, 'sgst') + itcOf(h, 'cess');
      totals.taxable += sign * h.taxable;
      totals.tax += sign * tax;
      totals.itc += sign * itc;
      if (d.registerItc !== null) engineItc += sign * itc;
      const itcCells = {
        eligibility,
        itcIgst: itcOf(h, 'igst'),
        itcCgst: itcOf(h, 'cgst'),
        itcSgst: itcOf(h, 'sgst'),
        itcCess: itcOf(h, 'cess'),
      };
      const taxCells = {
        rate,
        taxable: h.taxable,
        igst: h.igst,
        cgst: h.cgst,
        sgst: h.sgst,
        cess: h.cess,
      };

      if (d.kind === 'debit_note') {
        const registered = d.supplierGstin !== null && !foreign;
        const target = registered ? rows.cdnr : rows.cdnur;
        target.push({
          ...(registered ? { gstin: d.supplierGstin } : {}),
          number: d.number,
          date: d.date,
          originalNumber: d.original?.number ?? null,
          originalDate: d.original?.date ?? null,
          preGst: 'N',
          documentType: 'D',
          reason: NOTE_REASON[d.reasonCode ?? 'other'] ?? '07-Others',
          supply,
          noteValue: d.grandTotal,
          ...taxCells,
          ...itcCells,
        });
        continue;
      }

      if (imported) {
        const sez = (d.supplierTreatment ?? '').includes('sez');
        rows.impg.push({
          portCode: d.boePortCode,
          boeNumber: d.boeNumber,
          boeDate: d.boeDate,
          boeValue: d.grandTotal,
          documentType: sez ? 'Received from SEZ' : 'Imports',
          sezGstin: sez ? d.supplierGstin : null,
          rate,
          taxable: h.taxable,
          igst: h.igst,
          cess: h.cess,
          ...itcCells,
        });
      } else if (foreign) {
        rows.imps.push({
          number: d.number,
          date: d.date,
          value: d.grandTotal,
          pos,
          rate,
          taxable: h.taxable,
          igst: h.igst,
          cess: h.cess,
          ...itcCells,
        });
      } else if (d.supplierGstin) {
        rows.b2b.push({
          gstin: d.supplierGstin,
          number: d.number,
          date: d.date,
          value: d.grandTotal,
          pos,
          reverseCharge: d.reverseCharge ? 'Y' : 'N',
          invoiceType: 'Regular',
          ...taxCells,
          ...itcCells,
        });
      } else {
        rows.b2bur.push({
          name: d.supplierName,
          number: d.number,
          date: d.date,
          value: d.grandTotal,
          pos,
          supply,
          ...taxCells,
          ...itcCells,
        });
      }
    }
  }

  // --- Issues ----------------------------------------------------------------------------------
  if (skippedNonTax > 0) {
    issues.push({
      severity: 'info',
      code: 'non_tax_documents_left_out',
      count: skippedNonTax,
      message: `${skippedNonTax} document(s) with no taxable line were left out because "don't consider non tax transactions" is on.`,
    });
  }
  if (missingPos > 0) {
    issues.push({
      severity: 'warning',
      code: 'place_of_supply_missing',
      count: missingPos,
      message: `${missingPos} document(s) have no place of supply.`,
    });
  }
  if (missingHsn > 0) {
    issues.push({
      severity: 'warning',
      code: 'hsn_missing',
      count: missingHsn,
      message: `${missingHsn} line(s) have no HSN/SAC; they are listed as "NA".`,
    });
  }
  if (registerKnown > 0 && registerItc !== engineItc) {
    issues.push({
      severity: 'warning',
      code: 'itc_differs_from_register',
      message: `Availed credit here is ${engineItc} paise but the ITC register holds ${registerItc} paise for the same bills. Prepare GSTR-3B again or review the register before relying on either.`,
    });
  }
  if (rows.cdnr.length + rows.cdnur.length > 0) {
    issues.push({
      severity: 'info',
      code: 'note_reason_mapped',
      message:
        'Debit-note reasons are mapped to the nearest GSTR-2 reason (returns, damage, quality, expiry and short supply to 01-Sales Return; rate difference to 04-Correction in Invoice; other to 07-Others).',
    });
  }

  // --- Sheets ----------------------------------------------------------------------------------
  const taxCols = (withCgst: boolean) => [
    col('rate', 'Rate', 'percent'),
    col('taxable', 'Taxable Value', 'money', true),
    col('igst', 'Integrated Tax Paid', 'money', true),
    ...(withCgst
      ? [col('cgst', 'Central Tax Paid', 'money', true), col('sgst', 'State/UT Tax Paid', 'money', true)]
      : []),
    col('cess', 'Cess Paid', 'money', true),
  ];
  const itcCols = (withCgst: boolean) => [
    col('eligibility', 'Eligibility For ITC'),
    col('itcIgst', 'Availed ITC Integrated Tax', 'money', true),
    ...(withCgst
      ? [
          col('itcCgst', 'Availed ITC Central Tax', 'money', true),
          col('itcSgst', 'Availed ITC State/UT Tax', 'money', true),
        ]
      : []),
    col('itcCess', 'Availed ITC Cess', 'money', true),
  ];
  const noteCols = (registered: boolean) => [
    ...(registered ? [col('gstin', 'GSTIN of Supplier')] : []),
    col('number', registered ? 'Note/Refund Voucher Number' : 'Note/Voucher Number'),
    col('date', registered ? 'Note/Refund Voucher date' : 'Note/Voucher date', 'date'),
    col('originalNumber', 'Invoice/Advance Payment Voucher Number'),
    col('originalDate', 'Invoice/Advance Payment Voucher date', 'date'),
    col('preGst', 'Pre GST'),
    col('documentType', 'Document Type'),
    col('reason', 'Reason For Issuing document'),
    col('supply', 'Supply Type'),
    col('noteValue', registered ? 'Note/Refund Voucher Value' : 'Note/Voucher Value', 'money'),
    ...taxCols(true),
    ...itcCols(true),
  ];

  const hsnRows = [...hsn.values()]
    .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.uqc.localeCompare(b.uqc))
    .map((r) => ({
      hsn: r.hsn,
      description: null,
      uqc: r.uqc,
      quantity: r.qty,
      totalValue: r.value.taxable + r.value.igst + r.value.cgst + r.value.sgst + r.value.cess,
      taxable: r.value.taxable,
      igst: r.value.igst,
      cgst: r.value.cgst,
      sgst: r.value.sgst,
      cess: r.value.cess,
    }));

  const sheets: Sheet[] = [
    makeSheet(
      'b2b',
      'Purchases from registered suppliers',
      [
        col('gstin', 'GSTIN of Supplier'),
        col('number', 'Invoice Number'),
        col('date', 'Invoice date', 'date'),
        col('value', 'Invoice Value', 'money'),
        col('pos', 'Place Of Supply'),
        col('reverseCharge', 'Reverse Charge'),
        col('invoiceType', 'Invoice Type'),
        ...taxCols(true),
        ...itcCols(true),
      ],
      rows.b2b,
      { table: 'b2b' },
    ),
    makeSheet(
      'b2bur',
      'Purchases from unregistered suppliers',
      [
        col('name', 'Supplier Name'),
        col('number', 'Invoice Number'),
        col('date', 'Invoice date', 'date'),
        col('value', 'Invoice Value', 'money'),
        col('pos', 'Place Of Supply'),
        col('supply', 'Supply Type'),
        ...taxCols(true),
        ...itcCols(true),
      ],
      rows.b2bur,
      { table: 'b2bur' },
    ),
    makeSheet(
      'imps',
      'Import of services',
      [
        col('number', 'Invoice Number of Reg Recipient'),
        col('date', 'Invoice Date', 'date'),
        col('value', 'Invoice Value', 'money'),
        col('pos', 'Place Of Supply'),
        ...taxCols(false),
        ...itcCols(false),
      ],
      rows.imps,
      { table: 'imps' },
    ),
    makeSheet(
      'impg',
      'Import of goods (bill of entry)',
      [
        col('portCode', 'Port Code'),
        col('boeNumber', 'Bill Of Entry Number'),
        col('boeDate', 'Bill Of Entry Date', 'date'),
        col('boeValue', 'Bill Of Entry Value', 'money'),
        col('documentType', 'Document type'),
        col('sezGstin', 'GSTIN Of SEZ Supplier'),
        ...taxCols(false),
        ...itcCols(false),
      ],
      rows.impg,
      { table: 'impg' },
    ),
    ...(input.includeNonTax
      ? [
          makeSheet(
            'exemp',
            'Composition, nil-rated, exempt and non-GST purchases',
            [
              col('description', 'Description'),
              col('composition', 'Composition taxable person', 'money', true),
              col('nil', 'Nil Rated Supplies', 'money', true),
              col('exempt', 'Exempted (other than nil rated/non GST supply )', 'money', true),
              col('nonGst', 'Non-GST supplies', 'money', true),
            ],
            [
              { description: 'Inter-State supplies', ...exemp.inter },
              { description: 'Intra-State supplies', ...exemp.intra },
            ],
            { table: 'exemp' },
          ),
        ]
      : []),
    makeSheet(
      'hsnsum',
      'HSN summary of purchases',
      [
        col('hsn', 'HSN'),
        col('description', 'Description'),
        col('uqc', 'UQC'),
        col('quantity', 'Total Quantity', 'quantity', true),
        col('totalValue', 'Total Value', 'money', true),
        col('taxable', 'Taxable Value', 'money', true),
        col('igst', 'Integrated Tax Amount', 'money', true),
        col('cgst', 'Central Tax Amount', 'money', true),
        col('sgst', 'State/UT Tax Amount', 'money', true),
        col('cess', 'Cess Amount', 'money', true),
      ],
      hsnRows,
      { table: 'hsnsum' },
    ),
    makeSheet('cdnr', 'Debit notes to registered suppliers', noteCols(true), rows.cdnr, {
      table: 'cdnr',
    }),
    makeSheet('cdnur', 'Debit notes to unregistered suppliers', noteCols(false), rows.cdnur, {
      table: 'cdnur',
    }),
  ];

  return { sheets, issues, totals };
}
