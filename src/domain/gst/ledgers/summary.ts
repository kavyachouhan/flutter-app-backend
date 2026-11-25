/**
 * What the electronic ledgers say about tax paid and credit reclaimed or reversed, as the annual
 * return needs it. The GSTR-9 engine reads only this shape, so where it comes from (imported
 * ledger files today, a GSP fetch later) can change without touching the engine.
 *
 * Two parts are deliberately different in how far they can be trusted:
 *
 * - Credit reclaimed (4(D)(1)) and reversed (4(B)(2)) come from the credit reversal and re-claim
 *   ledger, whose keys name what each amount is. Nothing is interpreted.
 * - Tax paid through cash or credit comes from the cash and liability ledgers, which describe a
 *   payment only in free text and a discharge code. How an entry is read is a RULE (data, see
 *   `classify.ts`), and while no rule has been checked against real ledger files `paid` is null:
 *   unknown, never a guess and never zero.
 */
import type { TaxAmounts } from '../returns/model.js';
import { classifyEntry, type LedgerRuleSet } from './classify.js';
import { LEDGER_KINDS, TAX_HEADS, type LedgerEntry, type LedgerKind } from './types.js';

export type LedgerHead = 'igst' | 'cgst' | 'sgst' | 'cess' | 'interest' | 'lateFee' | 'penalty' | 'other';

export interface LedgerSummary {
  /** Return periods (`YYYY-MM`) every imported ledger covers; a partly covered year is reported. */
  readonly coveredMonths: readonly string[];
  /** Ledgers that have not been imported at all. */
  readonly missingKinds: readonly LedgerKind[];
  /**
   * Tax paid per head, split by how it was discharged. Null when no classification rule exists, so
   * the return shows paid as unknown rather than zero.
   */
  readonly paid: Readonly<Record<LedgerHead, { readonly cash: number; readonly itc: number }>> | null;
  /** ITC reclaimed (GSTR-3B 4(D)(1)), Table 6H. */
  readonly itcReclaimed: TaxAmounts;
  /** ITC reversed under 4(B)(2), for the Table 7 cross-check. */
  readonly itcReversed: TaxAmounts;
  /** Entries no rule matched: counted, never guessed into a head. Zero when there are no rules. */
  readonly unclassifiedEntries: number;
}

const ZERO: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
const add = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => ({
  igst: a.igst + b.igst,
  cgst: a.cgst + b.cgst,
  sgst: a.sgst + b.sgst,
  cess: a.cess + b.cess,
});

const HEADS: readonly LedgerHead[] = ['igst', 'cgst', 'sgst', 'cess', 'interest', 'lateFee', 'penalty', 'other'];

export interface SummariseInput {
  readonly entries: readonly LedgerEntry[];
  readonly rules: LedgerRuleSet;
  /** Months (`YYYY-MM`) covered by the imported files of each kind; a kind absent here is missing. */
  readonly coveredByKind: Readonly<Partial<Record<LedgerKind, readonly string[]>>>;
}

export function summariseLedgers(input: SummariseInput): LedgerSummary {
  const present = LEDGER_KINDS.filter((k) => input.coveredByKind[k] !== undefined);
  const missingKinds = LEDGER_KINDS.filter((k) => input.coveredByKind[k] === undefined);

  // A month counts as covered only when every ledger that was imported covers it.
  let covered: string[] | null = null;
  for (const kind of present) {
    const months = input.coveredByKind[kind] ?? [];
    covered = covered === null ? [...months] : covered.filter((m) => months.includes(m));
  }

  let reclaimed = ZERO;
  let reversed = ZERO;
  for (const e of input.entries) {
    if (e.itc) {
      reclaimed = add(reclaimed, e.itc.reclaimed);
      reversed = add(reversed, e.itc.reversed);
    }
  }

  const usable = input.rules.rules.some((r) => r.effect === 'paid_cash' || r.effect === 'paid_itc');
  let paid: Record<LedgerHead, { cash: number; itc: number }> | null = null;
  let unclassified = 0;
  if (usable) {
    paid = Object.fromEntries(HEADS.map((h) => [h, { cash: 0, itc: 0 }])) as Record<
      LedgerHead,
      { cash: number; itc: number }
    >;
    for (const e of input.entries) {
      if (e.kind === 'itc_reversal' || !e.amounts) continue;
      const rule = classifyEntry(e, input.rules);
      if (!rule) {
        unclassified++;
        continue;
      }
      if (rule.effect === 'ignore') continue;
      const slot = rule.effect === 'paid_cash' ? 'cash' : 'itc';
      for (const head of TAX_HEADS) {
        const b = e.amounts[head];
        paid[head][slot] += Math.abs(b.tax);
        paid.interest[slot] += Math.abs(b.interest);
        paid.penalty[slot] += Math.abs(b.penalty);
        paid.other[slot] += Math.abs(b.other);
        paid.lateFee[slot] += Math.abs(b.fee);
      }
    }
  }

  return {
    coveredMonths: covered ?? [],
    missingKinds,
    paid,
    itcReclaimed: reclaimed,
    itcReversed: reversed,
    unclassifiedEntries: unclassified,
  };
}
