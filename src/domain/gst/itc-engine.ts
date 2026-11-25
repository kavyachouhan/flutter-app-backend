/**
 * The input tax credit engine (milestone A7, decision D25). Pure: facts in, a period's GSTR-3B
 * Table 4 and the movements behind it out. Nothing here reads a database or a clock.
 *
 * Law applied (texts in `docs/gst/`, in-force dates in `GST_PHASE2_GAP_ANALYSIS.md` §2):
 *   - s.16(2)(aa) (from 01.01.2022): domestic credit only to the extent it is in GSTR-2B. The
 *     claim is the smaller of the books and 2B, head by head. A document not yet in 2B stays
 *     pending and is carried forward.
 *   - s.16(2)(b) and its first proviso: goods received, and for goods received in lots, credit on
 *     the last lot (`receiptComplete`).
 *   - s.16(4): no credit after 30 November following the end of the financial year of the
 *     invoice. A return for October is the last that can carry it (due 20 November), so a claim
 *     in a later period goes to 4(D)(2) instead.
 *   - s.16(2) second and third provisos with Rule 37: value plus tax not paid within 180 days of
 *     the invoice date, so the credit for the unpaid part is reversed (4(B)(2)). It is reclaimed on
 *     payment (4(A)(5), also shown in 4(D)(1)). Interest under s.50 is flagged, not computed.
 *   - s.17(5) blocked credit and Rule 42/43 credit for exempt or non-business use: reported in
 *     4(A) and reversed in 4(B)(1) (Circular 170/02/2022), never claimed net.
 *   - Rule 42 (inputs, input services, monthly): D1 = (E/F) x C2 for common credit, and D2 = 5% of
 *     C2 where common credit is also used for non-business purposes. The annual true-up under
 *     Rule 42(2) is not computed (flagged).
 *   - Rule 43 (capital goods, monthly): Tm = Tc/60 over the 60-month useful life, and
 *     Te = (E/F) x Tm. The official text of clause (g) still reads `Tr`, whose definition was
 *     omitted by 16/2020-CT; Tm is the only per-period common credit left, so it is used (an
 *     assumption recorded in GST_PENDING §3).
 *   - GSTR-2B 'ITC not available' rows (s.16(4) / place of supply) go to 4(D)(2) (12/2024 GSTR-2B
 *     instructions, Table 4).
 *   - Reverse charge: credit in the period the tax is paid, 4(A)(3) (domestic) or 4(A)(2) (import
 *     of services). Import of goods: 4(A)(1) from the bill of entry. Neither waits for 2B.
 */
import type { TaxAmounts } from './returns/model.js';

export type Paise = number;
export type YearMonth = string; // 'YYYY-MM'

/** How the inward supply is used, which decides Rule 42/43. */
export const ITC_USES = [
  'business_taxable',
  'common',
  'common_with_non_business',
  'exempt_only',
  'non_business',
] as const;
export type ItcUse = (typeof ITC_USES)[number];

/** Clauses of s.17(5) as amended to 2025 (FA 2023 inserted (fa); FA 2025 changed (d)). */
export const BLOCKED_CREDIT_CODES = [
  's17_5_a', // motor vehicles (13 or fewer persons) except specified uses
  's17_5_aa', // vessels and aircraft except specified uses
  's17_5_ab', // insurance, servicing, repair of (a)/(aa)
  's17_5_b_i', // food, beverages, catering, beauty, health, cosmetic surgery, leasing, life/health insurance
  's17_5_b_ii', // club, health and fitness membership
  's17_5_b_iii', // travel benefits to employees on vacation
  's17_5_c', // works contract for immovable property
  's17_5_d', // construction of immovable property on own account
  's17_5_e', // goods or services on which composition tax was paid
  's17_5_f', // received by a non-resident taxable person (except imports)
  's17_5_fa', // CSR obligations under s.135 Companies Act (from 01.10.2023)
  's17_5_g', // personal consumption
  's17_5_h', // lost, stolen, destroyed, written off, gifts, free samples
  's17_5_i', // tax paid under s.74 (up to FY 2023-24)
] as const;
export type BlockedCreditCode = (typeof BLOCKED_CREDIT_CODES)[number];

export type ItcDocKind = 'domestic' | 'rcm_domestic' | 'rcm_import_services' | 'import_goods';

export type Table4Line = 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'b1' | 'b2' | 'd1' | 'd2';
export type MovementKind = 'claim' | 'reverse_permanent' | 'reverse_temporary' | 'reclaim' | 'ineligible';
export type MovementRule =
  | 'none'
  | 's17_5'
  | 'rule_37'
  | 'rule_37a'
  | 'rule_42'
  | 'rule_43'
  | 's16_4'
  | 'not_available_in_2b';

export interface ItcPayment {
  readonly date: string; // ISO date
  readonly amount: Paise;
}

/** What earlier filed returns already did with a document (sums of its movements). */
export interface ItcHistory {
  readonly claimed: TaxAmounts;
  readonly reversedTemporary: TaxAmounts;
  readonly reclaimed: TaxAmounts;
  /** Reported as ineligible (4(D)(2)) or claimed and permanently reversed: nothing more to do. */
  readonly closed: boolean;
}

export interface ItcDocument {
  readonly registerId: string;
  readonly sourceType: 'purchase_bill' | 'debit_note';
  readonly number: string;
  readonly supplierGstin: string | null;
  /** Supplier's invoice (or our debit note) date. */
  readonly documentDate: string;
  /** Goods or services received; null means on the document date. */
  readonly receivedDate: string | null;
  /** False while goods invoiced together are still arriving in lots. */
  readonly receiptComplete: boolean;
  readonly kind: ItcDocKind;
  readonly blocked: BlockedCreditCode | 'unspecified' | null;
  readonly use: ItcUse;
  readonly capitalGoods: boolean;
  /** Signed: a debit note (goods returned) is negative. */
  readonly tax: TaxAmounts;
  /** Value plus tax payable to the supplier (purchase bills; Rule 37). */
  readonly payable: Paise;
  /** Debit notes against the bill, which reduce what is payable. */
  readonly returned: Paise;
  readonly payments: readonly ItcPayment[];
  /** The document in GSTR-2B: its 2B period, the portal's verdict and the tax 2B shows. */
  readonly twoB: { readonly period: YearMonth; readonly available: boolean; readonly tax: TaxAmounts } | null;
  /**
   * Whether GSTR-2B is imported for the document's month or later. When it is not, the engine
   * cannot tell whether the supplier reported the document, so it follows the books and says so
   * (warning `itc_without_2b`); the portal itself fills Table 4 from 2B.
   */
  readonly twoBTracked: boolean;
  readonly history: ItcHistory;
}

/** Common capital goods (Rule 43) still within their 60-month useful life. */
export interface CommonCapitalGood {
  readonly registerId: string;
  readonly documentDate: string;
  readonly tax: TaxAmounts;
}

export interface ItcPeriodInput {
  readonly period: { readonly year: number; readonly month: number };
  readonly documents: readonly ItcDocument[];
  readonly commonCapitalGoods: readonly CommonCapitalGood[];
  /** Rule 42/43 turnover for the period: exempt supplies (E) and total turnover in the State (F). */
  readonly turnover: { readonly exempt: Paise; readonly total: Paise };
}

export interface ItcMovement {
  readonly registerId: string | null;
  readonly kind: MovementKind;
  readonly rule: MovementRule;
  readonly line: Table4Line;
  readonly tax: TaxAmounts;
  readonly note: string;
}

export type PendingReason =
  | 'not_in_2b'
  | 'in_later_2b'
  | 'goods_not_received'
  | 'receipt_incomplete';

export interface ItcPending {
  readonly registerId: string;
  readonly number: string;
  readonly supplierGstin: string | null;
  readonly documentDate: string;
  readonly reason: PendingReason;
  readonly tax: TaxAmounts;
  /** The last return period the credit can still be claimed in (s.16(4)). */
  readonly lastClaimPeriod: YearMonth;
}

export interface ItcIssue {
  readonly severity: 'info' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly ref?: string;
  readonly count?: number;
}

export interface Table4 {
  readonly available: {
    readonly import_goods: TaxAmounts;
    readonly import_services: TaxAmounts;
    readonly reverse_charge: TaxAmounts;
    readonly isd: TaxAmounts;
    readonly other: TaxAmounts;
  };
  readonly reversed: { readonly rules_38_42_43_17_5: TaxAmounts; readonly other: TaxAmounts };
  readonly ineligible: {
    readonly reclaimed_after_reversal: TaxAmounts;
    readonly section_16_4_or_pos: TaxAmounts;
  };
}

export interface ItcPeriodResult {
  readonly movements: readonly ItcMovement[];
  readonly table4: Table4;
  readonly pending: readonly ItcPending[];
  readonly issues: readonly ItcIssue[];
}

// --- tax arithmetic ----------------------------------------------------------------------------

export const ZERO: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
const HEADS = ['igst', 'cgst', 'sgst', 'cess'] as const;

const map = (a: TaxAmounts, f: (v: number, h: (typeof HEADS)[number]) => number): TaxAmounts => ({
  igst: f(a.igst, 'igst'),
  cgst: f(a.cgst, 'cgst'),
  sgst: f(a.sgst, 'sgst'),
  cess: f(a.cess, 'cess'),
});
export const addTax = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => map(a, (v, h) => v + b[h]);
export const subTax = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => map(a, (v, h) => v - b[h]);
const scale = (a: TaxAmounts, k: number): TaxAmounts => map(a, (v) => Math.round(v * k));
const isZero = (a: TaxAmounts): boolean => HEADS.every((h) => a[h] === 0);
/** Head by head, the smaller of the two in absolute terms (same sign as `books`). */
const limitTo = (books: TaxAmounts, cap: TaxAmounts): TaxAmounts =>
  map(books, (v, h) => (v >= 0 ? Math.max(0, Math.min(v, cap[h])) : v));
const nonNegative = (a: TaxAmounts): TaxAmounts => map(a, (v) => Math.max(0, v));

// --- dates -------------------------------------------------------------------------------------

export const yearMonth = (y: number, m: number): YearMonth => `${y}-${String(m).padStart(2, '0')}`;

function lastDay(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yearMonth(y, m)}-${String(d).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The last return period that can carry credit for a document dated `date` (s.16(4)): the
 * return for October after the financial year (due 20 November, before the 30 November limit).
 */
export function lastClaimPeriod(date: string): YearMonth {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const fyStart = m >= 4 ? y : y - 1;
  return yearMonth(fyStart + 1, 10);
}

/** Rule 37: the day after which unpaid value means the credit must be reversed. */
export const rule37Day = (documentDate: string): string => addDays(documentDate, 180);

// --- engine ------------------------------------------------------------------------------------

const CLAIM_LINE: Readonly<Record<ItcDocKind, Table4Line>> = {
  import_goods: 'a1',
  rcm_import_services: 'a2',
  rcm_domestic: 'a3',
  domestic: 'a5',
};

export function runItcPeriod(input: ItcPeriodInput): ItcPeriodResult {
  const { year, month } = input.period;
  const period = yearMonth(year, month);
  const periodEnd = lastDay(year, month);
  const movements: ItcMovement[] = [];
  const pending: ItcPending[] = [];
  const issues: ItcIssue[] = [];
  const ratio = input.turnover.total > 0 ? input.turnover.exempt / input.turnover.total : 0;
  let commonInputCredit = ZERO; // C2 of Rule 42 for this period
  let commonNonBusinessCredit = ZERO;
  let interestNeeded = 0;
  let withoutTwoB = 0;
  const newCommonCapitalGoods: CommonCapitalGood[] = [];

  const push = (m: ItcMovement) => {
    if (!isZero(m.tax)) movements.push(m);
  };

  for (const d of input.documents) {
    if (d.history.closed) continue;
    const claimedSoFar = d.history.claimed;
    const neverClaimed = isZero(claimedSoFar);

    if (neverClaimed) {
      if (d.documentDate > periodEnd) continue;
      const deadline = lastClaimPeriod(d.documentDate);

      // Debit notes reduce credit in the period of the note, whatever 2B says.
      if (d.sourceType === 'debit_note' || HEADS.every((h) => d.tax[h] <= 0)) {
        push({
          registerId: d.registerId,
          kind: 'claim',
          rule: 'none',
          line: CLAIM_LINE[d.kind],
          tax: d.tax,
          note: `${d.number}: credit returned to the supplier`,
        });
        continue;
      }

      // The portal says no credit (s.16(4) or place of supply): 4(D)(2), closed.
      if (d.kind === 'domestic' && d.twoB && !d.twoB.available && d.twoB.period <= period) {
        push({
          registerId: d.registerId,
          kind: 'ineligible',
          rule: 'not_available_in_2b',
          line: 'd2',
          tax: d.twoB.tax,
          note: `${d.number}: GSTR-2B marks the credit not available`,
        });
        continue;
      }

      const received = (d.receivedDate ?? d.documentDate) <= periodEnd;
      let wait: PendingReason | null = null;
      if (!received) wait = 'goods_not_received';
      else if (!d.receiptComplete) wait = 'receipt_incomplete';
      else if (d.kind === 'domestic' && !d.twoB && d.twoBTracked) wait = 'not_in_2b';
      else if (d.kind === 'domestic' && d.twoB && d.twoB.period > period) wait = 'in_later_2b';

      if (period > deadline) {
        // s.16(4): the window closed while the conditions were still open.
        push({
          registerId: d.registerId,
          kind: 'ineligible',
          rule: 's16_4',
          line: 'd2',
          tax: d.tax,
          note: `${d.number}: time limit under s.16(4) passed (last return ${deadline})`,
        });
        continue;
      }
      if (wait) {
        pending.push({
          registerId: d.registerId,
          number: d.number,
          supplierGstin: d.supplierGstin,
          documentDate: d.documentDate,
          reason: wait,
          tax: d.tax,
          lastClaimPeriod: deadline,
        });
        continue;
      }

      if (d.kind === 'domestic' && !d.twoB) withoutTwoB += 1;
      const claim = d.kind === 'domestic' && d.twoB ? limitTo(d.tax, d.twoB.tax) : d.tax;
      if (d.kind === 'domestic' && d.twoB && !isZero(subTax(d.tax, claim))) {
        issues.push({
          severity: 'info',
          code: 'itc_limited_to_2b',
          ref: d.number,
          message: `${d.number}: credit limited to what GSTR-2B shows (s.16(2)(aa)); the rest is not claimed.`,
        });
      }
      push({
        registerId: d.registerId,
        kind: 'claim',
        rule: 'none',
        line: CLAIM_LINE[d.kind],
        tax: claim,
        note: `${d.number}: credit claimed`,
      });

      // Permanently not available: 17(5), or exclusive exempt / non-business use.
      if (d.blocked) {
        push({
          registerId: d.registerId,
          kind: 'reverse_permanent',
          rule: 's17_5',
          line: 'b1',
          tax: claim,
          note: `${d.number}: blocked credit under ${d.blocked === 'unspecified' ? 's.17(5)' : d.blocked.replace(/^s17_5_/, 's.17(5)(').replace(/_/g, ')(') + ')'}`,
        });
      } else if (d.use === 'exempt_only' || d.use === 'non_business') {
        push({
          registerId: d.registerId,
          kind: 'reverse_permanent',
          rule: d.capitalGoods ? 'rule_43' : 'rule_42',
          line: 'b1',
          tax: claim,
          note: `${d.number}: used only for ${d.use === 'exempt_only' ? 'exempt supplies' : 'non-business purposes'}`,
        });
      } else if ((d.use === 'common' || d.use === 'common_with_non_business') && d.capitalGoods) {
        newCommonCapitalGoods.push({ registerId: d.registerId, documentDate: d.documentDate, tax: claim });
      } else if (d.use === 'common' || d.use === 'common_with_non_business') {
        commonInputCredit = addTax(commonInputCredit, claim);
        if (d.use === 'common_with_non_business') {
          commonNonBusinessCredit = addTax(commonNonBusinessCredit, claim);
        }
      }
      // Rule 37 can also bite in the same period for an old bill claimed late.
      rule37(d, claim, ZERO, ZERO);
      continue;
    }

    rule37(d, claimedSoFar, d.history.reversedTemporary, d.history.reclaimed);
  }

  /** Rule 37 for a domestic, non-reverse-charge purchase bill already claimed. */
  function rule37(d: ItcDocument, claimed: TaxAmounts, reversed: TaxAmounts, reclaimed: TaxAmounts) {
    if (d.kind !== 'domestic' || d.sourceType !== 'purchase_bill' || d.blocked) return;
    if (d.use === 'exempt_only' || d.use === 'non_business') return;
    const day = rule37Day(d.documentDate);
    if (day > periodEnd) return;
    const due = Math.max(0, d.payable - d.returned);
    if (due === 0) return;
    const paidBy = (date: string) =>
      d.payments.filter((p) => p.date <= date).reduce((s, p) => s + p.amount, 0);
    const unpaidAtDeadline = Math.max(0, due - paidBy(day));
    if (unpaidAtDeadline === 0) return;

    const shouldBeReversed = nonNegative(scale(claimed, unpaidAtDeadline / due));
    const newReversal = nonNegative(subTax(shouldBeReversed, reversed));
    if (!isZero(newReversal)) {
      interestNeeded += 1;
      push({
        registerId: d.registerId,
        kind: 'reverse_temporary',
        rule: 'rule_37',
        line: 'b2',
        tax: newReversal,
        note: `${d.number}: not paid within 180 days (by ${day})`,
      });
    }
    // Paid after the 180 days: reclaim in proportion, up to what was reversed.
    const paidLate = Math.min(unpaidAtDeadline, Math.max(0, paidBy(periodEnd) - paidBy(day)));
    if (paidLate === 0) return;
    const totalReversed = addTax(reversed, newReversal);
    const reclaimable = map(scale(shouldBeReversed, paidLate / unpaidAtDeadline), (v, h) =>
      Math.min(v, totalReversed[h]),
    );
    const newReclaim = nonNegative(subTax(reclaimable, reclaimed));
    if (!isZero(newReclaim)) {
      push({
        registerId: d.registerId,
        kind: 'reclaim',
        rule: 'rule_37',
        line: 'a5',
        tax: newReclaim,
        note: `${d.number}: paid after 180 days, credit reclaimed`,
      });
    }
  }

  // Rule 42 (inputs and input services, this period's common credit).
  if (!isZero(commonInputCredit)) {
    const d1 = scale(commonInputCredit, ratio);
    push({
      registerId: null,
      kind: 'reverse_permanent',
      rule: 'rule_42',
      line: 'b1',
      tax: d1,
      note: `Rule 42 D1: common credit x exempt/total turnover (${(ratio * 100).toFixed(2)}%)`,
    });
    if (!isZero(commonNonBusinessCredit)) {
      push({
        registerId: null,
        kind: 'reverse_permanent',
        rule: 'rule_42',
        line: 'b1',
        tax: scale(commonNonBusinessCredit, 0.05),
        note: 'Rule 42 D2: 5% of common credit also used for non-business purposes',
      });
    }
    issues.push({
      severity: 'info',
      code: 'rule42_annual_true_up',
      message:
        'Rule 42 reversal is worked out monthly; the final figure for the year (Rule 42(2)) must be settled by the September return after the year ends. Not computed here.',
    });
  }

  // Rule 43 (common capital goods within 60 months of their invoice).
  const inLife = [...input.commonCapitalGoods, ...newCommonCapitalGoods].filter(
    // Useful life: five years from the invoice (Rule 43(1)(c), Explanation to (e)).
    (c) => c.documentDate <= periodEnd && c.documentDate > lastDay(year - 5, month),
  );
  if (inLife.length > 0 && ratio > 0) {
    const tc = inLife.reduce((s, c) => addTax(s, c.tax), ZERO);
    const tm = scale(tc, 1 / 60);
    push({
      registerId: null,
      kind: 'reverse_permanent',
      rule: 'rule_43',
      line: 'b1',
      tax: scale(tm, ratio),
      note: `Rule 43 Te: (Tc/60) x exempt/total turnover (${(ratio * 100).toFixed(2)}%); ${inLife.length} capital good(s) in use`,
    });
  }

  if (interestNeeded > 0) {
    issues.push({
      severity: 'warning',
      code: 'rule37_interest',
      count: interestNeeded,
      message: `Credit on ${interestNeeded} bill(s) is reversed under Rule 37 (not paid within 180 days). Interest under s.50 is payable on credit availed and utilised; it is not computed here.`,
    });
  }
  if (withoutTwoB > 0) {
    issues.push({
      severity: 'warning',
      code: 'itc_without_2b',
      count: withoutTwoB,
      message: `Credit on ${withoutTwoB} purchase bill(s) is taken from the books because GSTR-2B is not imported for their month. Credit is allowed only to the extent it is in GSTR-2B (s.16(2)(aa)); import GSTR-2B to check it before filing.`,
    });
  }
  if (pending.length > 0) {
    const lapsing = pending.filter((p) => p.lastClaimPeriod === period);
    issues.push({
      severity: lapsing.length > 0 ? 'warning' : 'info',
      code: 'itc_pending',
      message: `${pending.length} purchase document(s) have credit not claimable yet (not in GSTR-2B, goods not received). It carries forward.${
        lapsing.length > 0
          ? ` ${lapsing.length} of them can be claimed no later than this return (s.16(4)).`
          : ''
      }`,
    });
  }

  return { movements, table4: table4Of(movements), pending, issues };
}

/** Sums movements into the GSTR-3B Table 4 shape. A reclaim is in 4(A)(5) and also in 4(D)(1). */
export function table4Of(movements: readonly ItcMovement[]): Table4 {
  const lines: Record<Table4Line, TaxAmounts> = {
    a1: ZERO, a2: ZERO, a3: ZERO, a4: ZERO, a5: ZERO, b1: ZERO, b2: ZERO, d1: ZERO, d2: ZERO,
  };
  for (const m of movements) {
    lines[m.line] = addTax(lines[m.line], m.tax);
    if (m.kind === 'reclaim') lines.d1 = addTax(lines.d1, m.tax);
  }
  return {
    available: {
      import_goods: lines.a1,
      import_services: lines.a2,
      reverse_charge: lines.a3,
      isd: lines.a4,
      other: lines.a5,
    },
    reversed: { rules_38_42_43_17_5: lines.b1, other: lines.b2 },
    ineligible: { reclaimed_after_reversal: lines.d1, section_16_4_or_pos: lines.d2 },
  };
}

/** A document's history after more movements (from a filed or a simulated earlier return). */
export function withMovements(doc: ItcDocument, movements: readonly ItcMovement[]): ItcDocument {
  let { claimed, reversedTemporary, reclaimed, closed } = doc.history;
  for (const m of movements) {
    if (m.registerId !== doc.registerId) continue;
    if (m.kind === 'claim') claimed = addTax(claimed, m.tax);
    else if (m.kind === 'reverse_temporary') reversedTemporary = addTax(reversedTemporary, m.tax);
    else if (m.kind === 'reclaim') reclaimed = addTax(reclaimed, m.tax);
    else closed = true; // ineligible or permanently reversed
  }
  // A debit note or other credit-reducing document is settled once claimed.
  if (doc.sourceType === 'debit_note' && !isZero(claimed)) closed = true;
  return { ...doc, history: { claimed, reversedTemporary, reclaimed, closed } };
}

/**
 * Runs the periods before `input.period` that have no filed return (`earlier`, oldest first) so
 * each document's history includes what those returns will claim, then the period itself. Without
 * this, every unfiled return would claim the same unclaimed credit again.
 */
export function runItcPeriodAfter(
  input: ItcPeriodInput,
  earlier: readonly { readonly year: number; readonly month: number }[],
): ItcPeriodResult {
  let documents = input.documents;
  for (const period of earlier) {
    const end = lastDay(period.year, period.month);
    const visible = documents.filter((d) => d.documentDate <= end);
    const result = runItcPeriod({
      period,
      documents: visible,
      commonCapitalGoods: [],
      turnover: { exempt: 0, total: 0 },
    });
    const byDoc = new Map<string, ItcMovement[]>();
    for (const m of result.movements) {
      if (!m.registerId) continue;
      const list = byDoc.get(m.registerId) ?? [];
      list.push(m);
      byDoc.set(m.registerId, list);
    }
    documents = documents.map((d) => {
      const own = byDoc.get(d.registerId);
      return own ? withMovements(d, own) : d;
    });
  }
  return runItcPeriod({ ...input, documents });
}
