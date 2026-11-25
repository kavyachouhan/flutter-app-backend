/**
 * GSTR-1 engine: from issued documents and their lines to the neutral return model and the sheets
 * shown on screen and exported.
 *
 * Pure. Classification is done per LINE, not per document, because one bill can carry taxable,
 * exempt and non-GST lines: the taxable lines belong in the invoice tables (4, 5, 7) and the rest
 * in table 8. Classifying the whole document would either overstate taxable value or lose the
 * exempt value.
 *
 * Nothing is dropped silently: every document that is left out of the return is counted and
 * reported as an issue, and sections the active payload mapper cannot express are counted in
 * `model.otherSections`.
 */
import { STATE_NAMES } from '../../print/states.js';
import { b2clThresholdPaise, type SupplyCategory, type SupplyType } from '../classify.js';
import {
  addHsnLine,
  hsnColumns,
  hsnSheetRows,
  sortedHsn,
  type HsnAcc,
} from './hsn-summary.js';
import {
  ZERO_TAXED,
  type Gstr1B2bParty,
  type Gstr1B2clGroup,
  type Gstr1B2csRow,
  type Gstr1Export,
  type Gstr1HsnRow,
  type Gstr1Invoice,
  type Gstr1Line,
  type Gstr1NilRow,
  type Gstr1Note,
  type Gstr1NoteParty,
  type Gstr1Return,
  type Gstr1UnregisteredNote,
  type NilSupply,
  type RecipientKind,
  type ReturnPeriod,
  type TaxedValue,
  type UnregisteredNoteKind,
} from './model.js';
import {
  col,
  makeSheet,
  type Sheet,
  type SheetCell,
  type SummaryLine,
  type WorkingIssue,
} from './sheets.js';

/** Issue code meaning: e-invoiced invoices are in the sheets but not in the neutral model. */
export const EINVOICE_LEFT_OUT_CODE = 'einvoice_left_out_of_model';

export interface EngineLine {
  readonly category: SupplyCategory;
  readonly hsn: string | null;
  readonly uqc: string | null;
  /** Thousandths of a unit. */
  readonly quantity: number;
  readonly taxable: number;
  readonly ratePercent: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
}

export type EngineDocKind = 'invoice' | 'credit_note' | 'debit_note';

export interface EngineDoc {
  readonly kind: EngineDocKind;
  readonly id: string;
  readonly number: string;
  /** ISO date. */
  readonly date: string;
  readonly status: string;
  readonly irnState: string;
  readonly supplyType: SupplyType;
  readonly placeOfSupply: string | null;
  readonly customerGstin: string | null;
  readonly customerUin: string | null;
  readonly customerName: string | null;
  /** The buyer's GST treatment (registered_composition, uin_holder, unregistered...). */
  readonly buyerTreatment: string | null;
  readonly grandTotal: number;
  readonly reverseCharge: boolean;
  readonly salesChannel: string | null;
  readonly ecoGstin: string | null;
  /** The invoice a credit/debit note corrects. */
  readonly original: {
    readonly number: string;
    readonly date: string;
    readonly grandTotal: number;
    readonly supplyType: SupplyType;
  } | null;
  readonly lines: readonly EngineLine[];
}

export interface Gstr1Options {
  /** Leave IRN-registered invoices out of the portal model: the portal pulls them from the IRP. */
  readonly excludeEinvoiceFromPortal: boolean;
}

export interface Gstr1Input {
  readonly gstin: string;
  readonly period: ReturnPeriod;
  readonly documents: readonly EngineDoc[];
  readonly options: Gstr1Options;
}

export interface Gstr1Workings {
  readonly form: 'gstr1';
  readonly gstin: string;
  readonly period: ReturnPeriod;
  readonly sheets: readonly Sheet[];
  readonly summary: readonly SummaryLine[];
  readonly issues: readonly WorkingIssue[];
  /** Net outward taxable value and tax of the period, the figures GSTR-3B 3.1 must agree with. */
  readonly totals: { readonly taxable: number; readonly tax: number };
  readonly model: Gstr1Return;
  /** Internal, net of notes and independent of mapper coverage; consumed by the 3B engine. */
  readonly net: Gstr1Net;
}

export interface Gstr1Net {
  /** Taxable outward supplies at a non-zero or zero rate, excluding exports and SEZ (3.1a). */
  readonly taxable: TaxedValue;
  /** Exports and SEZ taxable supplies (3.1b). */
  readonly zeroRated: TaxedValue;
  readonly nilExempt: number;
  readonly nonGst: number;
  /** Inter-state supplies in 3.1(a) to unregistered/composition/UIN recipients, per POS (3.2). */
  readonly interState: {
    readonly unregistered: ReadonlyMap<string, { taxable: number; igst: number }>;
    readonly composition: ReadonlyMap<string, { taxable: number; igst: number }>;
    readonly uin: ReadonlyMap<string, { taxable: number; igst: number }>;
  };
}

const add = (a: TaxedValue, b: TaxedValue, sign = 1): TaxedValue => ({
  taxable: a.taxable + sign * b.taxable,
  igst: a.igst + sign * b.igst,
  cgst: a.cgst + sign * b.cgst,
  sgst: a.sgst + sign * b.sgst,
  cess: a.cess + sign * b.cess,
});

const lineValue = (l: EngineLine): TaxedValue => ({
  taxable: l.taxable,
  igst: l.igst,
  cgst: l.cgst,
  sgst: l.sgst,
  cess: l.cess,
});

const sumLines = (lines: readonly EngineLine[]): TaxedValue =>
  lines.reduce((acc, l) => add(acc, lineValue(l)), ZERO_TAXED);

const toModelLine = (l: EngineLine): Gstr1Line => ({
  ratePercent: l.ratePercent,
  value: lineValue(l),
});

const posLabel = (pos: string | null): string =>
  pos ? `${pos}-${STATE_NAMES[pos] ?? 'Unknown'}` : '';

const isInter = (t: SupplyType): boolean => t !== 'intra_state';
const isExport = (t: SupplyType): boolean => t === 'export_with_tax' || t === 'export_without_tax';
const isSez = (t: SupplyType): boolean => t === 'sez_with_tax' || t === 'sez_without_tax';

const recipientOf = (d: EngineDoc): string | null => d.customerGstin ?? d.customerUin;

/** Which table-8 bucket a non-taxable line of this document falls in. */
function nilBucket(d: EngineDoc): 'INTRB2B' | 'INTRAB2B' | 'INTRB2C' | 'INTRAB2C' {
  const registered = recipientOf(d) !== null;
  const inter = isInter(d.supplyType);
  if (registered) return inter ? 'INTRB2B' : 'INTRAB2B';
  return inter ? 'INTRB2C' : 'INTRAB2C';
}

const NIL_BUCKETS = [
  ['INTRB2B', 'Inter-State supplies to registered persons'],
  ['INTRAB2B', 'Intra-State supplies to registered persons'],
  ['INTRB2C', 'Inter-State supplies to unregistered persons'],
  ['INTRAB2C', 'Intra-State supplies to unregistered persons'],
] as const;

function recipientKind(t: SupplyType): RecipientKind {
  if (t === 'sez_with_tax') return 'sez_with_payment';
  if (t === 'sez_without_tax') return 'sez_without_payment';
  return 'regular';
}

const INVOICE_TYPE_LABEL: Readonly<Record<RecipientKind, string>> = {
  regular: 'Regular B2B',
  sez_with_payment: 'SEZ supplies with payment',
  sez_without_payment: 'SEZ supplies without payment',
  deemed_export: 'Deemed Exp',
};

interface MutableB2cs {
  intraState: boolean;
  placeOfSupply: string;
  ratePercent: number;
  eco: string | null;
  value: TaxedValue;
}

export function buildGstr1(input: Gstr1Input): Gstr1Workings {
  const issues: WorkingIssue[] = [];
  const issue = (i: WorkingIssue) => issues.push(i);

  // --- Which documents take part -------------------------------------------------------------
  const included: EngineDoc[] = [];
  let pendingIrn = 0;
  let notIssued = 0;
  for (const d of input.documents) {
    if (d.status === 'issued') included.push(d);
    else if (d.status === 'pending_irn') pendingIrn++;
    else notIssued++;
  }
  if (pendingIrn > 0) {
    issue({
      severity: 'error',
      code: 'pending_irn_excluded',
      count: pendingIrn,
      message: `${pendingIrn} document(s) are waiting for an IRN and are not valid tax invoices yet, so they are left out of this return.`,
    });
  }
  if (notIssued > 0) {
    issue({
      severity: 'info',
      code: 'void_or_withdrawn_excluded',
      count: notIssued,
      message: `${notIssued} cancelled or withdrawn document(s) are not supplies; their numbers are reported in the documents-issued table.`,
    });
  }

  // --- Accumulators ---------------------------------------------------------------------------
  const b2bMap = new Map<string, Gstr1Invoice[]>();
  const b2clMap = new Map<string, Gstr1B2clGroup['invoices'][number][]>();
  const cdnrMap = new Map<string, Gstr1Note[]>();
  const cdnur: Gstr1UnregisteredNote[] = [];
  const b2csMap = new Map<string, MutableB2cs>();
  const exportsModel: Gstr1Export[] = [];
  const nil = new Map<string, { nil: number; exempt: number; nonGst: number }>();
  const hsnB2b = new Map<string, HsnAcc>();
  const hsnB2c = new Map<string, HsnAcc>();
  const sheetRows = {
    b2b: [] as Record<string, SheetCell>[],
    b2cl: [] as Record<string, SheetCell>[],
    cdnr: [] as Record<string, SheetCell>[],
    cdnur: [] as Record<string, SheetCell>[],
    exp: [] as Record<string, SheetCell>[],
  };

  let net = {
    taxable: ZERO_TAXED,
    zeroRated: ZERO_TAXED,
    nilExempt: 0,
    nonGst: 0,
  };
  const interUnreg = new Map<string, { taxable: number; igst: number }>();
  const interComp = new Map<string, { taxable: number; igst: number }>();
  const interUin = new Map<string, { taxable: number; igst: number }>();
  const bump = (
    m: Map<string, { taxable: number; igst: number }>,
    pos: string,
    taxable: number,
    igst: number,
  ) => {
    const cur = m.get(pos) ?? { taxable: 0, igst: 0 };
    m.set(pos, { taxable: cur.taxable + taxable, igst: cur.igst + igst });
  };

  let einvoiceCount = 0;
  let missingPos = 0;
  let missingUqc = 0;
  let missingHsn = 0;

  for (const d of included) {
    const isNote = d.kind !== 'invoice';
    const sign = d.kind === 'credit_note' ? -1 : 1;
    const taxableLines = d.lines.filter((l) => l.category === 'taxable');
    const otherLines = d.lines.filter((l) => l.category !== 'taxable');
    const einvoice = d.irnState === 'registered';
    if (einvoice && !isNote) einvoiceCount++;
    const forPortal = !(einvoice && input.options.excludeEinvoiceFromPortal);

    if (!d.placeOfSupply) {
      missingPos++;
    }
    const pos = d.placeOfSupply ?? '';
    const recipient = recipientOf(d);

    // Net totals (3.1) — all included documents, regardless of portal exclusion.
    const taxableValue = sumLines(taxableLines);
    if (isExport(d.supplyType) || isSez(d.supplyType)) {
      net = { ...net, zeroRated: add(net.zeroRated, taxableValue, sign) };
    } else {
      net = { ...net, taxable: add(net.taxable, taxableValue, sign) };
      if (isInter(d.supplyType) && pos) {
        // 3.2 classes: GSTIN-less buyer = unregistered; composition/UIN need the treatment.
        const target =
          d.buyerTreatment === 'registered_composition'
            ? interComp
            : d.buyerTreatment === 'uin_holder' || (d.customerUin && !d.customerGstin)
              ? interUin
              : recipient
                ? null
                : interUnreg;
        if (target) bump(target, pos, sign * taxableValue.taxable, sign * taxableValue.igst);
      }
    }
    for (const l of otherLines) {
      if (l.category === 'non_gst') net = { ...net, nonGst: net.nonGst + sign * l.taxable };
      else net = { ...net, nilExempt: net.nilExempt + sign * l.taxable };
    }

    // Table 8 buckets for non-taxable lines.
    if (otherLines.length > 0) {
      const key = nilBucket(d);
      const cur = nil.get(key) ?? { nil: 0, exempt: 0, nonGst: 0 };
      for (const l of otherLines) {
        if (l.category === 'nil_rated') cur.nil += sign * l.taxable;
        else if (l.category === 'exempt') cur.exempt += sign * l.taxable;
        else cur.nonGst += sign * l.taxable;
      }
      nil.set(key, cur);
    }

    // HSN: every line of every document, net of notes. Registered recipients go to the B2B table.
    for (const l of d.lines) {
      if (!l.hsn) missingHsn++;
      if (!l.uqc) missingUqc++;
      addHsnLine(recipient && !isExport(d.supplyType) ? hsnB2b : hsnB2c, l, sign);
    }

    if (taxableLines.length === 0) continue; // only table 8 / HSN contributions

    const mark = einvoice ? 'Y' : 'N';

    // ---- Exports ----------------------------------------------------------------------------
    if (isExport(d.supplyType)) {
      if (!isNote) {
        if (forPortal) {
          exportsModel.push({
            exportType: d.supplyType === 'export_with_tax' ? 'with_payment' : 'without_payment',
            number: d.number,
            date: d.date,
            value: d.grandTotal,
            lines: taxableLines.map(toModelLine),
          });
        }
        const byRate = groupByRate(taxableLines);
        for (const [rate, v] of byRate) {
          sheetRows.exp.push({
            exportType: d.supplyType === 'export_with_tax' ? 'WPAY' : 'WOPAY',
            number: d.number,
            date: d.date,
            invoiceValue: d.grandTotal,
            portCode: null,
            shippingBillNo: null,
            shippingBillDate: null,
            rate,
            taxable: v.taxable,
            igst: v.igst,
            cess: v.cess,
            einvoice: mark,
          });
        }
        issue({
          severity: 'warning',
          code: 'export_shipping_bill_missing',
          ref: d.number,
          message: `Export invoice ${d.number} has no shipping bill number, date or port code on file; the portal requires them.`,
        });
      } else {
        // Credit/debit note on an export: unregistered note (EXPWP/EXPWOP).
        if (forPortal) {
          cdnur.push({
            kind: d.kind === 'credit_note' ? 'credit' : 'debit',
            type:
              d.supplyType === 'export_with_tax' ? 'export_with_payment' : 'export_without_payment',
            number: d.number,
            date: d.date,
            value: d.grandTotal,
            placeOfSupply: pos,
            lines: taxableLines.map(toModelLine),
          });
        }
        pushNoteRows(sheetRows.cdnur, d, taxableLines, 'EXPWP/EXPWOP', mark, posLabel(pos));
      }
      continue;
    }

    // ---- SEZ and registered recipients -------------------------------------------------------
    if (isSez(d.supplyType) && !recipient) {
      issue({
        severity: 'error',
        code: 'sez_recipient_gstin_missing',
        ref: d.number,
        message: `SEZ supply ${d.number} has no recipient GSTIN, so it cannot be reported.`,
      });
      continue;
    }

    if (recipient) {
      const kind = recipientKind(d.supplyType);
      if (!isNote) {
        const inv: Gstr1Invoice = {
          number: d.number,
          date: d.date,
          value: d.grandTotal,
          placeOfSupply: pos,
          reverseCharge: d.reverseCharge,
          recipientKind: kind,
          ...(d.ecoGstin ? { ecommerceGstin: d.ecoGstin } : {}),
          lines: taxableLines.map(toModelLine),
        };
        if (forPortal) pushTo(b2bMap, recipient, inv);
        for (const [rate, v] of groupByRate(taxableLines)) {
          sheetRows.b2b.push({
            gstin: recipient,
            name: d.customerName,
            number: d.number,
            date: d.date,
            invoiceValue: d.grandTotal,
            pos: posLabel(pos),
            reverseCharge: d.reverseCharge ? 'Y' : 'N',
            invoiceType: INVOICE_TYPE_LABEL[kind],
            ecoGstin: d.ecoGstin,
            rate,
            taxable: v.taxable,
            cess: v.cess,
            igst: v.igst,
            cgst: v.cgst,
            sgst: v.sgst,
            einvoice: mark,
          });
        }
      } else {
        const note: Gstr1Note = {
          kind: d.kind === 'credit_note' ? 'credit' : 'debit',
          number: d.number,
          date: d.date,
          value: d.grandTotal,
          placeOfSupply: pos,
          reverseCharge: d.reverseCharge,
          recipientKind: kind,
          ...(d.original
            ? { originalInvoiceNumber: d.original.number, originalInvoiceDate: d.original.date }
            : {}),
          lines: taxableLines.map(toModelLine),
        };
        if (forPortal) pushTo(cdnrMap, recipient, note);
        pushNoteRows(sheetRows.cdnr, d, taxableLines, 'CDNR', mark, posLabel(pos), recipient);
      }
      continue;
    }

    // ---- Unregistered recipients ---------------------------------------------------------------
    if (!isNote) {
      const large = isInter(d.supplyType) && d.grandTotal > b2clThresholdPaise(d.date);
      if (large) {
        const inv = {
          number: d.number,
          date: d.date,
          value: d.grandTotal,
          ...(d.ecoGstin ? { ecommerceGstin: d.ecoGstin } : {}),
          lines: taxableLines.map(toModelLine),
        };
        if (forPortal) pushTo(b2clMap, pos, inv);
        for (const [rate, v] of groupByRate(taxableLines)) {
          sheetRows.b2cl.push({
            number: d.number,
            date: d.date,
            invoiceValue: d.grandTotal,
            pos: posLabel(pos),
            ecoGstin: d.ecoGstin,
            rate,
            taxable: v.taxable,
            cess: v.cess,
            igst: v.igst,
            einvoice: mark,
          });
        }
      } else {
        if (forPortal) addB2cs(b2csMap, d, taxableLines, pos, 1);
      }
    } else {
      // A note to an unregistered buyer: reported (9B cdnur) only when the original was B2CL or an
      // export; otherwise it nets off the B2CS table so the rate-wise total stays right.
      const original = d.original;
      const originalWasLarge =
        original !== null &&
        isInter(original.supplyType) &&
        original.grandTotal > b2clThresholdPaise(original.date);
      if (original === null) {
        issue({
          severity: 'warning',
          code: 'note_original_unknown',
          ref: d.number,
          message: `${d.number} has no original invoice on file; it is netted into B2CS.`,
        });
      }
      if (originalWasLarge) {
        const type: UnregisteredNoteKind = 'b2cl';
        if (forPortal) {
          cdnur.push({
            kind: d.kind === 'credit_note' ? 'credit' : 'debit',
            type,
            number: d.number,
            date: d.date,
            value: d.grandTotal,
            placeOfSupply: pos,
            lines: taxableLines.map(toModelLine),
          });
        }
        pushNoteRows(sheetRows.cdnur, d, taxableLines, 'B2CL', mark, posLabel(pos));
      } else if (forPortal) {
        addB2cs(b2csMap, d, taxableLines, pos, sign);
      }
    }
  }

  // --- Issues from data quality ---------------------------------------------------------------
  if (missingPos > 0) {
    issue({
      severity: 'error',
      code: 'place_of_supply_missing',
      count: missingPos,
      message: `${missingPos} document(s) have no place of supply and cannot be reported correctly.`,
    });
  }
  if (missingHsn > 0) {
    issue({
      severity: 'warning',
      code: 'hsn_missing',
      count: missingHsn,
      message: `${missingHsn} line(s) have no HSN/SAC; they are listed as "NA" in table 12.`,
    });
  }
  if (missingUqc > 0) {
    issue({
      severity: 'warning',
      code: 'uqc_missing',
      count: missingUqc,
      message: `${missingUqc} line(s) have no unit quantity code; "OTH" is used in table 12.`,
    });
  }
  if (einvoiceCount > 0) {
    issue({
      severity: 'info',
      // Distinct codes: GSTR-9 must know when a stored model leaves e-invoiced invoices out.
      code: input.options.excludeEinvoiceFromPortal
        ? EINVOICE_LEFT_OUT_CODE
        : 'einvoice_in_workings',
      count: einvoiceCount,
      message: input.options.excludeEinvoiceFromPortal
        ? `${einvoiceCount} e-invoiced invoice(s) are shown here but left out of the portal file: the portal fills them in from the IRP.`
        : `${einvoiceCount} e-invoiced invoice(s) are included in the portal file; uploading them again can create duplicates.`,
    });
  }
  const negativeB2cs = [...b2csMap.values()].filter((r) => r.value.taxable < 0).length;
  if (negativeB2cs > 0) {
    issue({
      severity: 'warning',
      code: 'b2cs_negative',
      count: negativeB2cs,
      message: `${negativeB2cs} B2CS row(s) are negative after netting credit notes; check the original period.`,
    });
  }

  // --- Model ----------------------------------------------------------------------------------
  const b2b: Gstr1B2bParty[] = [...b2bMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recipientGstin, invoices]) => ({ recipientGstin, invoices: sortDocs(invoices) }));
  const b2cl: Gstr1B2clGroup[] = [...b2clMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([placeOfSupply, invoices]) => ({ placeOfSupply, invoices: sortDocs(invoices) }));
  const b2cs: Gstr1B2csRow[] = [...b2csMap.values()]
    .sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.ratePercent - b.ratePercent)
    .map((r) => ({
      intraState: r.intraState,
      placeOfSupply: r.placeOfSupply,
      ratePercent: r.ratePercent,
      viaEcommerce: r.eco !== null,
      ...(r.eco ? { ecommerceGstin: r.eco } : {}),
      value: r.value,
    }));
  const notes: Gstr1NoteParty[] = [...cdnrMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recipientGstin, ns]) => ({ recipientGstin, notes: sortDocs(ns) }));

  const hsnB2bRows = sortedHsn(hsnB2b);
  const hsnB2cRows = sortedHsn(hsnB2c);

  const NIL_SUPPLY: Readonly<Record<string, NilSupply>> = {
    INTRB2B: 'inter_state_registered',
    INTRAB2B: 'intra_state_registered',
    INTRB2C: 'inter_state_unregistered',
    INTRAB2C: 'intra_state_unregistered',
  };
  const nilModel: Gstr1NilRow[] = [...nil.entries()]
    .filter(([, v]) => v.nil !== 0 || v.exempt !== 0 || v.nonGst !== 0)
    .map(([key, v]) => ({
      supply: NIL_SUPPLY[key] as NilSupply,
      nilRated: v.nil,
      exempt: v.exempt,
      nonGst: v.nonGst,
    }));
  const hsnModel = (rows: HsnAcc[]): Gstr1HsnRow[] =>
    rows.map((r) => ({
      hsn: r.hsn,
      uqc: r.uqc,
      quantity: r.quantity,
      ratePercent: r.ratePercent,
      value: r.value,
    }));

  const model: Gstr1Return = {
    gstin: input.gstin,
    period: input.period,
    b2b,
    b2cl,
    b2cs,
    creditDebitNotesRegistered: notes,
    creditDebitNotesUnregistered: cdnur,
    exports: exportsModel,
    nilExemptNonGst: nilModel,
    hsnB2b: hsnModel(hsnB2bRows),
    hsnB2c: hsnModel(hsnB2cRows),
    // Table 13 is built from the number registry by the service, which fills this in.
    documentsIssued: [],
    otherSections: {},
  };

  issue({
    severity: 'info',
    code: 'advances_not_computed',
    message:
      'Advances received and adjusted (table 11) and e-commerce tables (14, 15) are not computed here. Enter them on the portal if they apply.',
  });
  if (included.some((d) => d.ecoGstin !== null)) {
    issue({
      severity: 'warning',
      code: 'ecommerce_operator_not_reported',
      message:
        'Some sales went through an e-commerce operator. The portal upload format has no operator GSTIN on these rows; report them in the e-commerce tables on the portal.',
    });
  }

  // --- Sheets ---------------------------------------------------------------------------------
  const b2csSheetRows = b2cs.map((r) => ({
    type: r.viaEcommerce ? 'E' : 'OE',
    supply: r.intraState ? 'Intra-State' : 'Inter-State',
    pos: posLabel(r.placeOfSupply),
    ecoGstin: r.ecommerceGstin ?? null,
    rate: r.ratePercent,
    taxable: r.value.taxable,
    cess: r.value.cess,
    igst: r.value.igst,
    cgst: r.value.cgst,
    sgst: r.value.sgst,
  }));

  const nilRows = NIL_BUCKETS.map(([key, label]) => {
    const v = nil.get(key) ?? { nil: 0, exempt: 0, nonGst: 0 };
    return { description: label, nil: v.nil, exempt: v.exempt, nonGst: v.nonGst };
  });

  const sheets: Sheet[] = [
    makeSheet(
      'b2b',
      'B2B, SEZ and deemed exports',
      [
        col('gstin', 'GSTIN/UIN of Recipient'),
        col('name', 'Receiver Name'),
        col('number', 'Invoice Number'),
        col('date', 'Invoice date', 'date'),
        col('invoiceValue', 'Invoice Value', 'money'),
        col('pos', 'Place Of Supply'),
        col('reverseCharge', 'Reverse Charge'),
        col('invoiceType', 'Invoice Type'),
        col('ecoGstin', 'E-Commerce GSTIN'),
        col('rate', 'Rate', 'percent'),
        col('taxable', 'Taxable Value', 'money', true),
        col('cess', 'Cess Amount', 'money', true),
        col('igst', 'Integrated Tax', 'money', true),
        col('cgst', 'Central Tax', 'money', true),
        col('sgst', 'State/UT Tax', 'money', true),
        col('einvoice', 'e-Invoice'),
      ],
      sheetRows.b2b,
      { table: '4A, 4B, 6B, 6C' },
    ),
    makeSheet(
      'b2cl',
      'B2C large (inter-state above the limit)',
      [
        col('number', 'Invoice Number'),
        col('date', 'Invoice date', 'date'),
        col('invoiceValue', 'Invoice Value', 'money'),
        col('pos', 'Place Of Supply'),
        col('ecoGstin', 'E-Commerce GSTIN'),
        col('rate', 'Rate', 'percent'),
        col('taxable', 'Taxable Value', 'money', true),
        col('cess', 'Cess Amount', 'money', true),
        col('igst', 'Integrated Tax', 'money', true),
        col('einvoice', 'e-Invoice'),
      ],
      sheetRows.b2cl,
      { table: '5' },
    ),
    makeSheet(
      'b2cs',
      'B2C small (rate-wise)',
      [
        col('type', 'Type'),
        col('supply', 'Supply'),
        col('pos', 'Place Of Supply'),
        col('ecoGstin', 'E-Commerce GSTIN'),
        col('rate', 'Rate', 'percent'),
        col('taxable', 'Taxable Value', 'money', true),
        col('cess', 'Cess Amount', 'money', true),
        col('igst', 'Integrated Tax', 'money', true),
        col('cgst', 'Central Tax', 'money', true),
        col('sgst', 'State/UT Tax', 'money', true),
      ],
      b2csSheetRows,
      { table: '7', note: 'Credit notes to unregistered buyers are netted here.' },
    ),
    makeSheet('cdnr', 'Credit / debit notes, registered', noteColumns(true), sheetRows.cdnr, {
      table: '9B',
    }),
    makeSheet('cdnur', 'Credit / debit notes, unregistered', noteColumns(false), sheetRows.cdnur, {
      table: '9B',
    }),
    makeSheet(
      'exp',
      'Exports',
      [
        col('exportType', 'Export Type'),
        col('number', 'Invoice Number'),
        col('date', 'Invoice date', 'date'),
        col('invoiceValue', 'Invoice Value', 'money'),
        col('portCode', 'Port Code'),
        col('shippingBillNo', 'Shipping Bill Number'),
        col('shippingBillDate', 'Shipping Bill Date', 'date'),
        col('rate', 'Rate', 'percent'),
        col('taxable', 'Taxable Value', 'money', true),
        col('igst', 'Integrated Tax', 'money', true),
        col('cess', 'Cess Amount', 'money', true),
        col('einvoice', 'e-Invoice'),
      ],
      sheetRows.exp,
      { table: '6A' },
    ),
    makeSheet(
      'exemp',
      'Nil-rated, exempted and non-GST supplies',
      [
        col('description', 'Description'),
        col('nil', 'Nil Rated Supplies', 'money', true),
        col('exempt', 'Exempted (other than nil rated/non GST supply)', 'money', true),
        col('nonGst', 'Non-GST Supplies', 'money', true),
      ],
      nilRows,
      { table: '8' },
    ),
    makeSheet('hsn_b2b', 'HSN summary, B2B', hsnColumns(), hsnSheetRows(hsnB2bRows), {
      table: '12',
    }),
    makeSheet('hsn_b2c', 'HSN summary, B2C', hsnColumns(), hsnSheetRows(hsnB2cRows), {
      table: '12',
      note: 'Exports are listed here; the portal rule for exports in the B2B/B2C split is not confirmed.',
    }),
  ];

  const netTotals = {
    taxable: net.taxable.taxable + net.zeroRated.taxable,
    tax:
      net.taxable.igst +
      net.taxable.cgst +
      net.taxable.sgst +
      net.taxable.cess +
      net.zeroRated.igst +
      net.zeroRated.cess,
  };

  const summary: SummaryLine[] = sheets
    .filter((s) => ['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'exp'].includes(s.id))
    .map((s) => ({
      key: s.id,
      label: `${s.table ?? ''} ${s.title}`.trim(),
      records: s.rows.length,
      taxable: s.totals['taxable'] ?? 0,
      igst: s.totals['igst'] ?? 0,
      cgst: s.totals['cgst'] ?? 0,
      sgst: s.totals['sgst'] ?? 0,
      cess: s.totals['cess'] ?? 0,
      value: 0,
    }));

  return {
    form: 'gstr1',
    gstin: input.gstin,
    period: input.period,
    sheets,
    summary,
    issues,
    totals: netTotals,
    model,
    net: {
      taxable: net.taxable,
      zeroRated: net.zeroRated,
      nilExempt: net.nilExempt,
      nonGst: net.nonGst,
      interState: { unregistered: interUnreg, composition: interComp, uin: interUin },
    },
  };
}

// --- helpers -----------------------------------------------------------------------------------

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function sortDocs<T extends { number: string; date: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

function groupByRate(lines: readonly EngineLine[]): [number, TaxedValue][] {
  const m = new Map<number, TaxedValue>();
  for (const l of lines)
    m.set(l.ratePercent, add(m.get(l.ratePercent) ?? ZERO_TAXED, lineValue(l)));
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

function addB2cs(
  map: Map<string, MutableB2cs>,
  d: EngineDoc,
  lines: readonly EngineLine[],
  pos: string,
  sign: number,
): void {
  const intra = !isInter(d.supplyType);
  for (const [rate, v] of groupByRate(lines)) {
    const key = `${intra}|${pos}|${rate}|${d.ecoGstin ?? ''}`;
    const cur = map.get(key) ?? {
      intraState: intra,
      placeOfSupply: pos,
      ratePercent: rate,
      eco: d.ecoGstin,
      value: ZERO_TAXED,
    };
    cur.value = add(cur.value, v, sign);
    map.set(key, cur);
  }
}

function pushNoteRows(
  rows: Record<string, SheetCell>[],
  d: EngineDoc,
  lines: readonly EngineLine[],
  urType: string,
  mark: string,
  pos: string,
  recipient?: string,
): void {
  for (const [rate, v] of groupByRate(lines)) {
    rows.push({
      ...(recipient !== undefined ? { gstin: recipient, name: d.customerName } : { urType }),
      number: d.number,
      date: d.date,
      noteType: d.kind === 'credit_note' ? 'C' : 'D',
      pos,
      reverseCharge: d.reverseCharge ? 'Y' : 'N',
      noteValue: d.grandTotal,
      rate,
      taxable: v.taxable,
      cess: v.cess,
      igst: v.igst,
      cgst: v.cgst,
      sgst: v.sgst,
      originalInvoice: d.original?.number ?? null,
      einvoice: mark,
    });
  }
}

function noteColumns(registered: boolean) {
  return [
    ...(registered
      ? [col('gstin', 'GSTIN/UIN of Recipient'), col('name', 'Receiver Name')]
      : [col('urType', 'UR Type')]),
    col('number', 'Note Number'),
    col('date', 'Note Date', 'date'),
    col('noteType', 'Note Type'),
    col('pos', 'Place Of Supply'),
    col('reverseCharge', 'Reverse Charge'),
    col('noteValue', 'Note Value', 'money'),
    col('rate', 'Rate', 'percent'),
    col('taxable', 'Taxable Value', 'money', true),
    col('cess', 'Cess Amount', 'money', true),
    col('igst', 'Integrated Tax', 'money', true),
    col('cgst', 'Central Tax', 'money', true),
    col('sgst', 'State/UT Tax', 'money', true),
    col('originalInvoice', 'Original Invoice'),
    col('einvoice', 'e-Invoice'),
  ];
}

