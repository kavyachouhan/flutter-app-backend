/**
 * GSTR-9 engine: the annual return, built from the returns the year already holds.
 *
 * The form asks for "details as declared in returns filed during the financial year", so Tables 4
 * to 9 are summed from the period returns (GSTR-1 and GSTR-3B models), not recomputed from bills.
 * Bills enter in three places only: the books reconciliation (does the year's returns agree with the
 * books), the credit split of Table 6 (the 3B model does not carry inputs / capital goods /
 * services), and Table 18. Pure.
 *
 * Labels follow the GSTR-9 Offline Tool v2.2 (28 Sep 2026), which is the form as notified.
 */
import { addHsnLine, hsnColumns, hsnSheetRows, sortedHsn, type HsnAcc } from './hsn-summary.js';
import {
  ZERO_TAX,
  ZERO_TAXED,
  type Gstr1Return,
  type Gstr3bReturn,
  type Gstr9Hsn,
  type Gstr9ItcType,
  type Gstr9Return,
  type Gstr9TaxHead,
  type Paise,
  type TaxAmounts,
  type TaxedValue,
} from './model.js';
import type { InwardDoc } from './purchase-register.js';
import { col, makeSheet, type Sheet, type SheetCell, type SummaryLine, type WorkingIssue } from './sheets.js';
import type { LedgerSummary } from '../ledgers/summary.js';

export type PeriodSource = 'filed' | 'prepared' | 'live';

/** One return period of the year (a month, or a quarter for a QRMP filer). */
export interface Gstr9Period {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly source: PeriodSource;
  /** Why a stored return was not used, e.g. e-invoices missing from its model. */
  readonly note?: string;
  readonly gstr1: Gstr1Return;
  readonly gstr3b: Gstr3bReturn;
}

/** One row of the credit register for the year, grouped by what decides its GSTR-9 row. */
export interface ItcRegisterRow {
  readonly category: 'inputs' | 'input_services' | 'capital_goods' | 'ineligible';
  readonly reverseCharge: boolean;
  readonly supplierRegistered: boolean;
  readonly importGoods: boolean;
  readonly foreignSupplier: boolean;
  readonly tax: TaxAmounts;
  readonly rows: number;
}

export interface Gstr9ItcBreakdown {
  readonly nonReverseCharge: Readonly<Record<Gstr9ItcType, TaxAmounts>>;
  readonly reverseChargeUnregistered: Readonly<Record<Gstr9ItcType, TaxAmounts>>;
  readonly reverseChargeRegistered: Readonly<Record<Gstr9ItcType, TaxAmounts>>;
  readonly importGoods: Readonly<Record<'ip' | 'cg', TaxAmounts>>;
  readonly importServices: TaxAmounts;
  /** Ineligible credit has lost its type in the register; it is shown as inputs and counted here. */
  readonly ineligibleTypeAssumed: number;
}

export interface Gstr9Input {
  readonly gstin: string;
  readonly fy: { readonly startYear: number; readonly endYear: number };
  readonly periods: readonly Gstr9Period[];
  /** The "consider non tax transactions as exempted" option: non-GST outward goes to 5D. */
  readonly considerNonTaxAsExempt: boolean;
  readonly itc: Gstr9ItcBreakdown;
  readonly twoB: { readonly monthsImported: number; readonly monthsExpected: number; readonly total: TaxAmounts };
  readonly inward: readonly InwardDoc[];
  /** Live books over the whole year, for the reconciliation sheet. */
  readonly books: { readonly outwardTaxable: Paise; readonly outwardTax: Paise };
  readonly ledger: LedgerSummary | null;
}

export interface Gstr9Workings {
  readonly form: 'gstr9';
  readonly gstin: string;
  readonly fy: { readonly startYear: number; readonly endYear: number };
  readonly sheets: readonly Sheet[];
  readonly summary: readonly SummaryLine[];
  readonly issues: readonly WorkingIssue[];
  /** Turnover (5N) and total tax payable (Table 9), the headline figures of the period list. */
  readonly totals: { readonly taxable: number; readonly tax: number };
  readonly model: Gstr9Return;
}

// --- arithmetic -------------------------------------------------------------------------------

const tv = (a: TaxedValue, b: TaxedValue, s = 1): TaxedValue => ({
  taxable: a.taxable + s * b.taxable,
  igst: a.igst + s * b.igst,
  cgst: a.cgst + s * b.cgst,
  sgst: a.sgst + s * b.sgst,
  cess: a.cess + s * b.cess,
});
const tx = (a: TaxAmounts, b: TaxAmounts, s = 1): TaxAmounts => ({
  igst: a.igst + s * b.igst,
  cgst: a.cgst + s * b.cgst,
  sgst: a.sgst + s * b.sgst,
  cess: a.cess + s * b.cess,
});
const taxOf = (v: TaxedValue): TaxAmounts => ({ igst: v.igst, cgst: v.cgst, sgst: v.sgst, cess: v.cess });
const total = (t: TaxAmounts): number => t.igst + t.cgst + t.sgst + t.cess;
const taxTotal = (v: TaxedValue): number => total(taxOf(v));
const sumTv = (list: readonly TaxedValue[]): TaxedValue => list.reduce((a, b) => tv(a, b), ZERO_TAXED);
const sumTx = (list: readonly TaxAmounts[]): TaxAmounts => list.reduce((a, b) => tx(a, b), ZERO_TAX);

const ITC_TYPES: readonly Gstr9ItcType[] = ['ip', 'cg', 'is'];
const zeroByType = (): Record<Gstr9ItcType, TaxAmounts> => ({ ip: ZERO_TAX, cg: ZERO_TAX, is: ZERO_TAX });

/** Credit register rows to the GSTR-9 Table 6 split. Pure so the routing rules can be tested. */
export function buildItcBreakdown(rows: readonly ItcRegisterRow[]): Gstr9ItcBreakdown {
  const nonRcm = zeroByType();
  const rcmUnreg = zeroByType();
  const rcmReg = zeroByType();
  const goods: Record<'ip' | 'cg', TaxAmounts> = { ip: ZERO_TAX, cg: ZERO_TAX };
  let services = ZERO_TAX;
  let assumed = 0;

  for (const r of rows) {
    let type: Gstr9ItcType = 'ip';
    if (r.category === 'capital_goods') type = 'cg';
    else if (r.category === 'input_services') type = 'is';
    else if (r.category === 'ineligible') assumed += r.rows;

    if (r.importGoods && !r.reverseCharge) {
      const g: 'ip' | 'cg' = type === 'cg' ? 'cg' : 'ip';
      goods[g] = tx(goods[g], r.tax);
    } else if (r.foreignSupplier) {
      services = tx(services, r.tax);
    } else if (r.reverseCharge) {
      const target = r.supplierRegistered ? rcmReg : rcmUnreg;
      target[type] = tx(target[type], r.tax);
    } else {
      nonRcm[type] = tx(nonRcm[type], r.tax);
    }
  }
  return {
    nonReverseCharge: nonRcm,
    reverseChargeUnregistered: rcmUnreg,
    reverseChargeRegistered: rcmReg,
    importGoods: goods,
    importServices: services,
    ineligibleTypeAssumed: assumed,
  };
}

// --- GSTR-1 models into Tables 4 and 5 --------------------------------------------------------

interface Outward {
  b2c: TaxedValue;
  b2b: TaxedValue;
  exp: TaxedValue;
  sez: TaxedValue;
  deemed: TaxedValue;
  creditNotes: TaxedValue;
  debitNotes: TaxedValue;
  zeroRated: Paise;
  sez5: Paise;
  rcm5: Paise;
  exempt: Paise;
  nil: Paise;
  nonGst: Paise;
  creditNotes5: Paise;
  debitNotes5: Paise;
}

function linesValue(lines: readonly { value: TaxedValue }[]): TaxedValue {
  return sumTv(lines.map((l) => l.value));
}

function aggregateOutward(models: readonly Gstr1Return[]): Outward {
  const o: Outward = {
    b2c: ZERO_TAXED, b2b: ZERO_TAXED, exp: ZERO_TAXED, sez: ZERO_TAXED, deemed: ZERO_TAXED,
    creditNotes: ZERO_TAXED, debitNotes: ZERO_TAXED,
    zeroRated: 0, sez5: 0, rcm5: 0, exempt: 0, nil: 0, nonGst: 0, creditNotes5: 0, debitNotes5: 0,
  };
  for (const m of models) {
    for (const g of m.b2cl) for (const inv of g.invoices) o.b2c = tv(o.b2c, linesValue(inv.lines));
    // B2CS already nets credit notes to unregistered buyers, so they are not repeated in 4I.
    for (const r of m.b2cs) o.b2c = tv(o.b2c, r.value);

    for (const party of m.b2b) {
      for (const inv of party.invoices) {
        const v = linesValue(inv.lines);
        if (inv.recipientKind === 'sez_without_payment') o.sez5 += v.taxable;
        else if (inv.recipientKind === 'sez_with_payment') o.sez = tv(o.sez, v);
        else if (inv.recipientKind === 'deemed_export') o.deemed = tv(o.deemed, v);
        else if (inv.reverseCharge) o.rcm5 += v.taxable;
        else o.b2b = tv(o.b2b, v);
      }
    }

    for (const e of m.exports) {
      const v = linesValue(e.lines);
      if (e.exportType === 'with_payment') o.exp = tv(o.exp, v);
      else o.zeroRated += v.taxable;
    }

    const note = (kind: 'credit' | 'debit', v: TaxedValue, to5: boolean) => {
      if (to5) {
        if (kind === 'credit') o.creditNotes5 += v.taxable;
        else o.debitNotes5 += v.taxable;
      } else if (kind === 'credit') o.creditNotes = tv(o.creditNotes, v);
      else o.debitNotes = tv(o.debitNotes, v);
    };
    for (const party of m.creditDebitNotesRegistered) {
      for (const n of party.notes) {
        const to5 = n.recipientKind === 'sez_without_payment' || (n.reverseCharge && n.recipientKind === 'regular');
        note(n.kind, linesValue(n.lines), to5);
      }
    }
    for (const n of m.creditDebitNotesUnregistered) {
      note(n.kind, linesValue(n.lines), n.type === 'export_without_payment');
    }

    for (const r of m.nilExemptNonGst) {
      o.nil += r.nilRated;
      o.exempt += r.exempt;
      o.nonGst += r.nonGst;
    }
  }
  return o;
}

// --- the engine -------------------------------------------------------------------------------

const HEADS: readonly (keyof TaxAmounts)[] = ['igst', 'cgst', 'sgst', 'cess'];

export function buildGstr9(input: Gstr9Input): Gstr9Workings {
  const issues: WorkingIssue[] = [];
  const issue = (i: WorkingIssue) => issues.push(i);
  const g1 = input.periods.map((p) => p.gstr1);
  const g3 = input.periods.map((p) => p.gstr3b);
  const o = aggregateOutward(g1);

  // --- Tables 4 and 5 ---
  const rchrg4 = sumTv(g3.map((m) => m.outward.inwardReverseCharge));
  // 4F: advances on which tax was paid and no invoice issued yet in the year, from GSTR-1 table 11
  // (11A received less 11B adjusted). 5C1: supplies through an operator liable under s.9(5), from
  // table 14(b) (12/2024-CT inserted 4G1 for operators and 5C1 for suppliers).
  const sumRows = (rows: readonly { value: TaxedValue }[]) => sumTv(rows.map((r) => r.value));
  const advances4f = tv(
    sumTv(g1.map((m) => sumRows(m.advances?.received ?? []))),
    sumTv(g1.map((m) => sumRows(m.advances?.adjusted ?? []))),
    -1,
  );
  const eco5c1 = g1.reduce((s, m) => s + (m.ecommerce?.s9_5 ?? []).reduce((x, r) => x + r.value.taxable, 0), 0);
  const t4Subtotal = sumTv([o.b2c, o.b2b, o.exp, o.sez, o.deemed, advances4f, rchrg4]);
  // 4M = -4I + 4J (+4K - 4L, which are not computed).
  const t4Adjust = tv(o.debitNotes, o.creditNotes, -1);
  const t4Net = tv(t4Subtotal, t4Adjust);

  const exempt5 = o.exempt + (input.considerNonTaxAsExempt ? o.nonGst : 0);
  const nonGst5 = input.considerNonTaxAsExempt ? 0 : o.nonGst;
  const t5Subtotal = o.zeroRated + o.sez5 + o.rcm5 + eco5c1 + exempt5 + o.nil + nonGst5;
  const t5Adjust = o.debitNotes5 - o.creditNotes5;
  const t5Net = t5Subtotal + t5Adjust;
  const turnover = t4Net.taxable + t5Net;

  // --- Table 6 ---
  const total3b = sumTx(
    g3.flatMap((m) => Object.values(m.itc.available)),
  );
  const b = input.itc;
  const sumTypes = (r: Readonly<Record<Gstr9ItcType, TaxAmounts>>) => sumTx(ITC_TYPES.map((t) => r[t]));
  const reclaimed = input.ledger?.itcReclaimed ?? ZERO_TAX;
  const sub6 = sumTx([
    sumTypes(b.nonReverseCharge),
    sumTypes(b.reverseChargeUnregistered),
    sumTypes(b.reverseChargeRegistered),
    b.importGoods.ip,
    b.importGoods.cg,
    b.importServices,
    reclaimed,
  ]);
  const a2 = total3b; // 6A1 (credit of the preceding year availed this year) is not tracked
  const diff6 = tx(sub6, a2, -1);

  // --- Table 7 ---
  const sec17 = sumTx(g3.map((m) => m.itc.reversed.rules_38_42_43_17_5));
  const otherRev = sumTx(g3.map((m) => m.itc.reversed.other));
  const rev7 = tx(sec17, otherRev);
  const net6o = tx(sub6, rev7, -1);

  // --- Table 8 (a partial reading: see the issues) ---
  const per2b = input.twoB.total;
  const itc6b = sumTx([
    sumTypes(b.nonReverseCharge),
  ]);
  const diff8 = tx(per2b, itc6b, -1);
  // The books hold one figure for IGST on imports of goods, so "paid" (8G) and "availed" (8H) come
  // from the same credit entries as 6E and 8I is zero until the bill-of-entry paid figure is held.
  const igstPaidOnImport = b.importGoods.ip.igst + b.importGoods.cg.igst;
  const igstAvailedOnImport = igstPaidOnImport;
  const lapsedImport = igstPaidOnImport - igstAvailedOnImport;

  // --- Table 9 ---
  const tax31 = sumTv(g3.flatMap((m) => [m.outward.taxable, { ...m.outward.zeroRated, cgst: 0, sgst: 0 }]));
  const payableBy = (h: keyof TaxAmounts): Paise => tax31[h] + rchrg4[h];
  const interest = sumTx(g3.map((m) => m.interest ?? ZERO_TAX));
  const lateFee = g3.reduce((s, m) => s + (m.lateFee ? m.lateFee.cgst + m.lateFee.sgst : 0), 0);
  const ledger = input.ledger;
  const head = (payable: Paise, paid: Paise | null): Gstr9TaxHead => ({ payable, paid });
  // Paid is unknown (null), not zero, until the ledgers are imported AND a classification rule
  // says how their entries are read.
  const paid = ledger?.paid ?? null;
  const paidOf = (h: keyof NonNullable<LedgerSummary['paid']>): Paise | null =>
    paid ? paid[h].cash + paid[h].itc : null;
  const t9 = {
    igst: head(payableBy('igst'), paidOf('igst')),
    cgst: head(payableBy('cgst'), paidOf('cgst')),
    sgst: head(payableBy('sgst'), paidOf('sgst')),
    cess: head(payableBy('cess'), paidOf('cess')),
    interest: head(total(interest), paidOf('interest')),
    lateFee: head(lateFee, paidOf('lateFee')),
    penalty: head(0, paidOf('penalty')),
    other: head(0, paidOf('other')),
  };

  // --- Tables 17 and 18 ---
  const outwardHsn = new Map<string, HsnAcc>();
  for (const m of g1) {
    for (const r of [...m.hsnB2b, ...m.hsnB2c]) {
      addHsnLine(outwardHsn, { hsn: r.hsn === 'NA' ? null : r.hsn, uqc: r.uqc === 'OTH' ? null : r.uqc, quantity: r.quantity, ratePercent: r.ratePercent, ...r.value }, 1);
    }
  }
  const inwardHsn = new Map<string, HsnAcc>();
  for (const d of input.inward) {
    const sign = d.kind === 'debit_note' ? -1 : 1;
    for (const l of d.lines) addHsnLine(inwardHsn, { hsn: l.hsn, uqc: l.unit, quantity: l.quantity, ratePercent: l.ratePercent, taxable: l.taxable, igst: l.igst, cgst: l.cgst, sgst: l.sgst, cess: l.cess }, sign);
  }
  const toHsn = (rows: HsnAcc[]): Gstr9Hsn[] =>
    rows.map((r) => ({ hsn: r.hsn, uqc: r.uqc, quantity: r.quantity, ratePercent: r.ratePercent, value: r.value }));

  const notComputed = [
    '4G1 supplies by e-commerce operators (operators only)', '4K 4L 5J 5K amendments', '6A1 6A2',
    '6K 6L 6M 7F 7G transitional and ITC-01/02 credit', '7A 7A1 7A2 7B 7C 7D rule-wise reversals',
    '8C 8E 8F 8H1', 'Tables 10 to 16',
  ];

  const model: Gstr9Return = {
    gstin: input.gstin,
    fy: input.fy,
    t4: {
      b2c: o.b2c, b2b: o.b2b, exp: o.exp, sez: o.sez, deemed: o.deemed,
      advances: advances4f, inwardReverseCharge: rchrg4, ecommerce: ZERO_TAXED,
      creditNotes: o.creditNotes, debitNotes: o.debitNotes,
      amendmentsAdded: ZERO_TAXED, amendmentsReduced: ZERO_TAXED,
    },
    t5: {
      zeroRated: o.zeroRated, sez: o.sez5, reverseCharge: o.rcm5, ecommerce: eco5c1,
      exempt: exempt5, nilRated: o.nil, nonGst: nonGst5,
      creditNotes: o.creditNotes5, debitNotes: o.debitNotes5,
      amendmentsAdded: 0, amendmentsReduced: 0,
    },
    t6: {
      total3b,
      nonReverseCharge: b.nonReverseCharge,
      reverseChargeUnregistered: b.reverseChargeUnregistered,
      reverseChargeRegistered: b.reverseChargeRegistered,
      importGoods: b.importGoods,
      importServices: b.importServices,
      isd: ZERO_TAX,
      reclaimed,
    },
    t7: { section17: sec17, other: otherRev },
    t9,
    hsnOutward: toHsn(sortedHsn(outwardHsn)),
    hsnInward: toHsn(sortedHsn(inwardHsn)),
    notComputed,
  };

  // --- Issues ---
  const live = input.periods.filter((p) => p.source === 'live');
  if (live.length > 0) {
    issue({
      severity: 'warning',
      code: 'period_not_prepared',
      count: live.length,
      message: `${live.length} period(s) have no prepared or filed return and were worked out from the books now: ${live.map((p) => p.label).join(', ')}. Prepare them so the annual return rests on the returns themselves.`,
    });
  }
  const recomputed = input.periods.filter((p) => p.note !== undefined);
  for (const p of recomputed) {
    issue({ severity: 'info', code: 'period_recomputed', ref: p.label, message: `${p.label}: ${p.note ?? ''}` });
  }
  const unfiled = input.periods.filter((p) => p.source === 'prepared');
  if (unfiled.length > 0) {
    issue({
      severity: 'info',
      code: 'period_prepared_not_filed',
      count: unfiled.length,
      message: `${unfiled.length} period(s) are prepared but not recorded as filed: ${unfiled.map((p) => p.label).join(', ')}.`,
    });
  }
  issue({ severity: 'info', code: 'advances_not_computed', message: 'Advances received (4F) and e-commerce operator supplies (4G1, 5C1) are not computed. Enter them on the portal if they apply.' });
  issue({ severity: 'info', code: 'amendments_not_computed', message: 'Amendments (4K, 4L, 5J, 5K) and the next-year amendments in Tables 10 to 13 are not computed. Enter them on the portal if they apply.' });
  issue({ severity: 'info', code: 'tables_10_16_not_computed', message: 'Tables 10 to 16 (previous-year transactions, differential tax, refunds and demands, composition and job-work supplies) are not computed and are not in the file.' });
  issue({ severity: 'info', code: 'reversal_rules_not_split', message: 'Reversals are known only as blocked credit (section 17(5)) and "other". Rules 37, 37A, 38, 39, 42 and 43 (7A to 7D) are not split out, so they show zero; enter them from your workings.' });
  issue({ severity: 'info', code: 'transition_credit_not_tracked', message: 'Transitional credit, ITC-01/02/02A credit (6K to 6M), reversals of it (7F, 7G) and ITC of the preceding year (6A1, 6A2) are not tracked and show zero.' });
  if (b.ineligibleTypeAssumed > 0) {
    issue({ severity: 'warning', code: 'itc_type_assumed', count: b.ineligibleTypeAssumed, message: `${b.ineligibleTypeAssumed} ineligible credit entr(ies) no longer record whether they were inputs, capital goods or services; they are shown as inputs in 6B to 6D.` });
  }
  if (!ledger) {
    issue({ severity: 'warning', code: 'ledger_not_imported', message: 'No electronic ledger has been imported, so tax paid (Table 9) and credit reclaimed (6H) are unknown rather than zero. Import the cash, liability and credit-reversal ledgers, or complete Table 9 and 6H on the portal.' });
  } else {
    if (ledger.missingKinds.length > 0) {
      issue({ severity: 'warning', code: 'ledger_kind_missing', count: ledger.missingKinds.length, message: `These ledgers have not been imported: ${ledger.missingKinds.join(', ')}.` });
    }
    const covered = new Set(ledger.coveredMonths);
    const missing = input.periods.flatMap((p) => monthsIn(p.from, p.to)).filter((m) => !covered.has(m));
    if (missing.length > 0) {
      issue({ severity: 'warning', code: 'ledger_months_missing', count: missing.length, message: `The imported ledgers do not cover ${missing.join(', ')}.` });
    }
    if (ledger.paid === null) {
      issue({ severity: 'warning', code: 'ledger_paid_not_classified', message: 'Tax paid (Table 9) is unknown: no classification rule for the cash and liability ledgers has been checked against real ledger files yet (data/gstn-ledger/classification-rules.json). Credit reclaimed (6H) is taken from the credit reversal ledger.' });
    } else if (ledger.unclassifiedEntries > 0) {
      issue({ severity: 'warning', code: 'ledger_entry_unclassified', count: ledger.unclassifiedEntries, message: `${ledger.unclassifiedEntries} ledger entr(ies) matched no classification rule and are not counted in Table 9.` });
    }
  }
  if (input.twoB.monthsImported < input.twoB.monthsExpected) {
    issue({ severity: 'warning', code: 'gstr2b_months_missing', count: input.twoB.monthsExpected - input.twoB.monthsImported, message: `GSTR-2B was imported for ${input.twoB.monthsImported} of ${input.twoB.monthsExpected} months, so 8A is incomplete.` });
  }
  issue({ severity: 'info', code: 'table8_partial', message: '8A is the credit marked available in imported GSTR-2B statements (reverse-charge rows excluded). 8C, 8E, 8F and 8H1 are not tracked; table 8 is not written to the JSON because the Save schema does not say which of its keys is which row.' });
  if (HEADS.some((h) => diff6[h] !== 0)) {
    issue({ severity: 'warning', code: 'itc_register_differs_from_3b', ref: '6J', message: `Credit per the register for the year differs from the credit declared in GSTR-3B by ${total(diff6)} paise in total (6J). A bill was added or changed after a return was prepared, or a reverse-charge purchase sits in a different month.` });
  }

  // Do the period returns agree with each other and with the books?
  const g3Outward = sumTv(g3.flatMap((m) => [m.outward.taxable, { ...m.outward.zeroRated, cgst: 0, sgst: 0 }]));
  // Everything GSTR-3B 3.1(a) and (b) holds: Table 4 without 4G, plus the Table 5 lines 3.1 also
  // counts (5A, 5B, 5C), net of both sets of notes.
  const g1Outward = t4Net.taxable - rchrg4.taxable + o.rcm5 + o.zeroRated + o.sez5 + t5Adjust;
  const g1OutwardTax = taxTotal(t4Net) - taxTotal(rchrg4);
  if (g1Outward !== g3Outward.taxable || g1OutwardTax !== taxTotal(g3Outward)) {
    issue({ severity: 'warning', code: 'gstr1_gstr3b_differ', ref: 'recon', message: `Outward supplies per the GSTR-1 tables (${g1Outward} paise, tax ${g1OutwardTax}) differ from GSTR-3B 3.1 (${g3Outward.taxable} paise, tax ${taxTotal(g3Outward)}). Prepare both returns again for the periods concerned.` });
  }
  if (g1Outward !== input.books.outwardTaxable || g1OutwardTax !== input.books.outwardTax) {
    issue({ severity: 'warning', code: 'returns_differ_from_books', ref: 'recon', message: `Outward supplies per the period returns (${g1Outward} paise) differ from the books now (${input.books.outwardTaxable} paise). Bills were added, changed or cancelled after the returns were prepared.` });
  }

  // --- Sheets ---
  const sheets = buildSheets({
    input, o, rchrg4, advances4f, eco5c1, t4Subtotal, t4Adjust, t4Net, exempt5, nonGst5, t5Subtotal, t5Adjust, t5Net, turnover,
    total3b, sub6, a2, diff6, reclaimed, sec17, otherRev, rev7, net6o, per2b, itc6b, diff8,
    igstPaidOnImport, igstAvailedOnImport, lapsedImport, t9, interest, g1Outward, g1OutwardTax, g3Outward,
    outwardHsn: sortedHsn(outwardHsn), inwardHsn: sortedHsn(inwardHsn),
  });

  const line = (key: string, label: string, v: Partial<TaxedValue>): SummaryLine => ({
    key, label, records: 0, taxable: v.taxable ?? 0, igst: v.igst ?? 0, cgst: v.cgst ?? 0,
    sgst: v.sgst ?? 0, cess: v.cess ?? 0, value: 0,
  });
  const payableAll = HEADS.reduce((s, h) => s + t9[h].payable, 0);
  const summary: SummaryLine[] = [
    line('t4', '4N Supplies on which tax is payable', t4Net),
    line('t5', '5M Turnover on which tax is not payable', { taxable: t5Net }),
    line('turnover', '5N Total turnover', { taxable: turnover }),
    line('t6', '6O Total ITC availed', { ...taxOf0(sub6) }),
    line('t7', '7I Total ITC reversed', { ...taxOf0(rev7) }),
    line('t9', 'Table 9 Tax payable', { igst: t9.igst.payable, cgst: t9.cgst.payable, sgst: t9.sgst.payable, cess: t9.cess.payable }),
  ];

  return {
    form: 'gstr9',
    gstin: input.gstin,
    fy: input.fy,
    sheets,
    summary,
    issues,
    totals: { taxable: turnover, tax: payableAll },
    model,
  };
}

const taxOf0 = (t: TaxAmounts): TaxAmounts => ({ ...t });

/** `YYYY-MM` for each month from `from` to `to` (inclusive ISO dates). */
export function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

// --- sheets -----------------------------------------------------------------------------------

type Ctx = {
  input: Gstr9Input;
  o: Outward;
  rchrg4: TaxedValue;
  advances4f: TaxedValue;
  eco5c1: Paise;
  t4Subtotal: TaxedValue;
  t4Adjust: TaxedValue;
  t4Net: TaxedValue;
  exempt5: Paise;
  nonGst5: Paise;
  t5Subtotal: Paise;
  t5Adjust: Paise;
  t5Net: Paise;
  turnover: Paise;
  total3b: TaxAmounts;
  sub6: TaxAmounts;
  a2: TaxAmounts;
  diff6: TaxAmounts;
  reclaimed: TaxAmounts;
  sec17: TaxAmounts;
  otherRev: TaxAmounts;
  rev7: TaxAmounts;
  net6o: TaxAmounts;
  per2b: TaxAmounts;
  itc6b: TaxAmounts;
  diff8: TaxAmounts;
  igstPaidOnImport: Paise;
  igstAvailedOnImport: Paise;
  lapsedImport: Paise;
  t9: Gstr9Return['t9'];
  interest: TaxAmounts;
  g1Outward: Paise;
  g1OutwardTax: Paise;
  g3Outward: TaxedValue;
  outwardHsn: HsnAcc[];
  inwardHsn: HsnAcc[];
};

type Row = Record<string, SheetCell>;

function buildSheets(c: Ctx): Sheet[] {
  const taxedRow = (ref: string, nature: string, v: TaxedValue): Row => ({
    ref, nature, taxable: v.taxable, cgst: v.cgst, sgst: v.sgst, igst: v.igst, cess: v.cess,
  });
  const valueRow = (ref: string, nature: string, taxable: Paise): Row => ({
    ref, nature, taxable, cgst: null, sgst: null, igst: null, cess: null,
  });
  const part2: Row[] = [
    taxedRow('4A', 'Supplies made to unregistered persons (B2C)', c.o.b2c),
    taxedRow('4B', 'Supplies made to registered persons (B2B)', c.o.b2b),
    taxedRow('4C', 'Zero rated supply (export) on payment of tax (except supplies to SEZs)', c.o.exp),
    taxedRow('4D', 'Supply to SEZs on payment of tax', c.o.sez),
    taxedRow('4E', 'Deemed exports', c.o.deemed),
    taxedRow('4F', 'Advances on which tax has been paid but invoice has not been issued', c.advances4f),
    taxedRow('4G', 'Inward supplies on which tax is to be paid on reverse charge basis', c.rchrg4),
    taxedRow('4G1', 'Supplies on which e-commerce operator is required to pay tax u/s 9(5)', ZERO_TAXED),
    taxedRow('4H', 'Sub-total (A to G1 above)', c.t4Subtotal),
    taxedRow('4I', 'Credit notes issued in respect of transactions specified in (B) to (E) above (-)', c.o.creditNotes),
    taxedRow('4J', 'Debit notes issued in respect of transactions specified in (B) to (E) above (+)', c.o.debitNotes),
    taxedRow('4K', 'Supplies / tax declared through amendments (+)', ZERO_TAXED),
    taxedRow('4L', 'Supplies / tax reduced through amendments (-)', ZERO_TAXED),
    taxedRow('4M', 'Sub total (I to L above)', c.t4Adjust),
    taxedRow('4N', 'Supplies and advances on which tax is to be paid (H + M above)', c.t4Net),
    valueRow('5A', 'Zero rated supply (export) without payment of tax', c.o.zeroRated),
    valueRow('5B', 'Supply to SEZs without payment of tax', c.o.sez5),
    valueRow('5C', 'Supplies on which tax is to be paid by the recipient on reverse charge basis', c.o.rcm5),
    valueRow('5C1', 'Supplies on which tax is to be paid by e-commerce operators u/s 9(5)', c.eco5c1),
    valueRow('5D', 'Exempted', c.exempt5),
    valueRow('5E', 'Nil Rated', c.o.nil),
    valueRow('5F', 'Non-GST supply (includes "no supply")', c.nonGst5),
    valueRow('5G', 'Sub total (A to F above)', c.t5Subtotal),
    valueRow('5H', 'Credit notes issued in respect of transactions specified in (A) to (F) above (-)', c.o.creditNotes5),
    valueRow('5I', 'Debit notes issued in respect of transactions specified in (A) to (F) above (+)', c.o.debitNotes5),
    valueRow('5J', 'Supplies declared through amendments (+)', 0),
    valueRow('5K', 'Supplies reduced through amendments (-)', 0),
    valueRow('5L', 'Sub total (H to K above)', c.t5Adjust),
    valueRow('5M', 'Turnover on which tax is not to be paid (G + L above)', c.t5Net),
    valueRow('5N', 'Total turnover (including advances) (4N + 5M - 4G1 above)', c.turnover),
  ];
  const taxCols = [
    col('cgst', 'Central Tax', 'money'),
    col('sgst', 'State Tax / UT Tax', 'money'),
    col('igst', 'Integrated Tax', 'money'),
    col('cess', 'Cess', 'money'),
  ];
  const t = (ref: string, nature: string, type: string | null, v: TaxAmounts): Row => ({
    ref, nature, type, cgst: v.cgst, sgst: v.sgst, igst: v.igst, cess: v.cess,
  });
  const typeLabel: Readonly<Record<Gstr9ItcType, string>> = { ip: 'Inputs', cg: 'Capital Goods', is: 'Input Services' };
  const b = c.input.itc;
  const byType = (ref: string, nature: string, r: Readonly<Record<Gstr9ItcType, TaxAmounts>>): Row[] =>
    (['ip', 'cg', 'is'] as const).map((k, i) => t(i === 0 ? ref : '', i === 0 ? nature : '', typeLabel[k], r[k]));

  const part3: Row[] = [
    t('6A', 'Total amount of input tax credit availed through FORM GSTR-3B (sum total of Table 4A of FORM GSTR-3B)', null, c.total3b),
    t('6A1', 'ITC of preceding financial year availed in the financial year (other than ITC reclaimed under rule 37 and rule 37A)', null, ZERO_TAX),
    t('6A2', 'Net ITC of the financial year (A - A1)', null, c.a2),
    ...byType('6B', 'Inward supplies (other than imports and inward supplies liable to reverse charge but includes services received from SEZs)', b.nonReverseCharge),
    ...byType('6C', 'Inward supplies received from unregistered persons liable to reverse charge (other than B above) on which tax is paid and ITC availed', b.reverseChargeUnregistered),
    ...byType('6D', 'Inward supplies received from registered persons liable to reverse charge (other than B above) on which tax is paid and ITC availed', b.reverseChargeRegistered),
    t('6E', 'Import of goods (including supplies from SEZ)', 'Inputs', b.importGoods.ip),
    t('', '', 'Capital Goods', b.importGoods.cg),
    t('6F', 'Import of services (excluding inward supplies from SEZs)', null, b.importServices),
    t('6G', 'Input tax credit received from ISD', null, ZERO_TAX),
    t('6H', 'Amount of ITC reclaimed under the provisions of the Act', null, c.reclaimed),
    t('6I', 'Sub-total (B to H above)', null, c.sub6),
    t('6J', 'Difference (I - A2 above)', null, c.diff6),
    t('6K', 'Transition credit through TRAN-1 (including revisions if any)', null, ZERO_TAX),
    t('6L', 'Transition credit through TRAN-2', null, ZERO_TAX),
    t('6M', 'ITC availed through ITC-01, ITC-02 and ITC-02A (other than GSTR-3B and TRAN forms)', null, ZERO_TAX),
    t('6N', 'Sub-total (K to M above)', null, ZERO_TAX),
    t('6O', 'Total ITC availed (I + N above)', null, c.sub6),
  ];
  const rev: Row[] = [
    t('7A', 'As per Rule 37', null, ZERO_TAX),
    t('7A1', 'As per Rule 37A', null, ZERO_TAX),
    t('7A2', 'As per Rule 38', null, ZERO_TAX),
    t('7B', 'As per Rule 39', null, ZERO_TAX),
    t('7C', 'As per Rule 42', null, ZERO_TAX),
    t('7D', 'As per Rule 43', null, ZERO_TAX),
    t('7E', 'As per section 17(5)', null, c.sec17),
    t('7F', 'Reversal of TRAN-I credit', null, ZERO_TAX),
    t('7G', 'Reversal of TRAN-II credit', null, ZERO_TAX),
    t('7H1', 'Other reversals (specify): GSTR-3B 4(B)(2)', null, c.otherRev),
    t('7I', 'Total ITC reversed (sum of A to H above)', null, c.rev7),
    t('7J', 'Net ITC available for utilization (6O - 7I)', null, c.net6o),
  ];
  const other: Row[] = [
    t('8A', 'ITC as per GSTR-2B [Table 3(I) thereof]', null, c.per2b),
    t('8B', 'ITC as per sum total of 6(B) above', null, c.itc6b),
    t('8C', 'ITC on inward supplies received during the financial year but availed in the next year (not tracked)', null, ZERO_TAX),
    t('8D', 'Difference [A - (B + C)]', null, c.diff8),
    t('8E', 'ITC available but not availed (not tracked)', null, ZERO_TAX),
    t('8F', 'ITC available but ineligible (not tracked)', null, ZERO_TAX),
    t('8G', 'IGST paid on import of goods (including supplies from SEZ): taken from the same credit entries as 6E', null, { igst: c.igstPaidOnImport, cgst: 0, sgst: 0, cess: 0 }),
    t('8H', 'IGST credit availed on import of goods (as per 6(E) above) in the financial year', null, { igst: c.igstAvailedOnImport, cgst: 0, sgst: 0, cess: 0 }),
    t('8H1', 'IGST credit availed on import of goods in the next financial year (not tracked)', null, ZERO_TAX),
    t('8I', 'Difference (G - H - H1)', null, { igst: c.lapsedImport, cgst: 0, sgst: 0, cess: 0 }),
  ];

  const paidCell = (h: Gstr9TaxHead): { paid: Paise | null; diff: Paise | null } => ({
    paid: h.paid,
    diff: h.paid === null ? null : h.payable - h.paid,
  });
  const t9row = (ref: string, label: string, h: Gstr9TaxHead): Row => ({
    ref, nature: label, payable: h.payable, ...paidCell(h),
  });
  const tax9: Row[] = [
    t9row('9A', 'Integrated Tax', c.t9.igst),
    t9row('9B', 'Central Tax', c.t9.cgst),
    t9row('9C', 'State/UT Tax', c.t9.sgst),
    t9row('9D', 'Cess', c.t9.cess),
    t9row('9E', 'Interest', c.t9.interest),
    t9row('9F', 'Late fee', c.t9.lateFee),
    t9row('9G', 'Penalty', c.t9.penalty),
    t9row('9H', 'Other', c.t9.other),
  ];

  const reconRow = (item: string, a: Paise, b3: Paise, books: Paise): Row => ({
    item, gstr1: a, gstr3b: b3, books, diff3b: a - b3, diffBooks: a - books,
  });
  const recon: Row[] = [
    reconRow('Outward taxable value, net of notes (4A-4E, 5A-5C, 4I-4J, 5H-5I; without 4G)', c.g1Outward, c.g3Outward.taxable, c.input.books.outwardTaxable),
    reconRow('Outward tax, net of notes', c.g1OutwardTax, taxTotal(c.g3Outward), c.input.books.outwardTax),
  ];

  const coverage: Row[] = c.input.periods.map((p) => ({
    period: p.label, from: p.from, to: p.to,
    source: p.source === 'live' ? 'Worked out now from the books' : p.source === 'prepared' ? 'Prepared return' : 'Filed return',
    note: p.note ?? null,
  }));

  return [
    makeSheet('pt2_outward', 'Part II: outward and inward supplies', [
      col('ref', 'Table'), col('nature', 'Nature of supplies'),
      col('taxable', 'Taxable Value', 'money'), ...taxCols,
    ], part2, { table: '4, 5', note: 'Credit notes are shown as positive amounts and subtracted in the sub-total, as the form labels them (-).' }),
    makeSheet('pt3_itc', 'Part III: ITC availed (Table 6)', [
      col('ref', 'Table'), col('nature', 'Description'), col('type', 'Type'), ...taxCols,
    ], part3, { table: '6' }),
    makeSheet('pt3_rev', 'Part III: ITC reversed (Table 7)', [
      col('ref', 'Table'), col('nature', 'Details'), col('type', 'Type'), ...taxCols,
    ], rev, { table: '7' }),
    makeSheet('pt3_other', 'Part III: other ITC information (Table 8)', [
      col('ref', 'Table'), col('nature', 'Details'), col('type', 'Type'), ...taxCols,
    ], other, { table: '8', note: 'Partly tracked: see the issues.' }),
    makeSheet('pt4_tax', 'Part IV: tax paid (Table 9)', [
      col('ref', 'Table'), col('nature', 'Description'),
      col('payable', 'Tax Payable', 'money'), col('paid', 'Total Tax Paid', 'money'),
      col('diff', 'Difference between Tax Payable and Paid', 'money'),
    ], tax9, { table: '9', note: 'Paid is blank until the electronic ledgers are imported.' }),
    makeSheet('hsn_out', 'Outward supplies by HSN (Table 17)', hsnColumns(), hsnSheetRows(c.outwardHsn), { table: '17' }),
    makeSheet('hsn_in', 'Inward supplies by HSN (Table 18)', hsnColumns(), hsnSheetRows(c.inwardHsn), { table: '18' }),
    makeSheet('recon', 'Returns against books', [
      col('item', 'Item'), col('gstr1', 'Per GSTR-1 tables', 'money'), col('gstr3b', 'Per GSTR-3B 3.1', 'money'),
      col('books', 'Per books now', 'money'), col('diff3b', 'GSTR-1 less 3B', 'money'), col('diffBooks', 'GSTR-1 less books', 'money'),
    ], recon, { table: 'check' }),
    makeSheet('coverage', 'Periods used', [
      col('period', 'Period'), col('from', 'From', 'date'), col('to', 'To', 'date'),
      col('source', 'Source'), col('note', 'Note'),
    ], coverage, { table: 'check' }),
  ];
}
