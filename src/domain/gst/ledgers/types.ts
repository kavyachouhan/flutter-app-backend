/**
 * The neutral form of the GSTN electronic ledgers.
 *
 * Like the return model, this carries no GSTN key names: a parser (one per ledger and format
 * version) turns the portal's JSON into these entries, and everything downstream (classification,
 * the GSTR-9 summary, storage) reads only these. A new portal format is a new parser.
 */
import type { TaxAmounts } from '../returns/model.js';

export const LEDGER_KINDS = ['cash', 'liability', 'itc_reversal'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const TAX_HEADS = ['igst', 'cgst', 'sgst', 'cess'] as const;
export type TaxHead = (typeof TAX_HEADS)[number];

/** One head's amounts split the way the cash and liability ledgers split them. Paise. */
export interface HeadBreakup {
  readonly tax: number;
  readonly interest: number;
  readonly penalty: number;
  readonly other: number;
  readonly fee: number;
}

export type LedgerDirection = 'credit' | 'debit';

export interface LedgerEntry {
  readonly kind: LedgerKind;
  /** Position in the source file, for the audit trail and for reporting problems. */
  readonly rowNo: number;
  /** ISO date, or null when the portal's date could not be read. */
  readonly date: string | null;
  /** Return period `YYYY-MM`, when the entry names one. */
  readonly returnPeriod: string | null;
  readonly refNo: string | null;
  readonly description: string;
  /** Cash and liability ledgers only. Null when the portal's marker was not Cr or Dr. */
  readonly direction: LedgerDirection | null;
  /** Liability ledger only: how the portal says the liability was discharged. */
  readonly dischargeType: string | null;
  /** Cash and liability ledgers: the amounts of the entry per head. */
  readonly amounts: Readonly<Record<TaxHead, HeadBreakup>> | null;
  /** Credit reversal and reclaim ledger: what the entry reversed (4(B)(2)) or reclaimed (4(D)(1)). */
  readonly itc: {
    readonly reversed: TaxAmounts;
    readonly reclaimed: TaxAmounts;
    readonly availed: TaxAmounts;
  } | null;
}

export interface LedgerIssue {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly rowNo?: number;
}

export interface ParsedLedger {
  readonly kind: LedgerKind;
  readonly gstin: string;
  /** The window the file says it covers (ISO dates), or empty when it could not be read. */
  readonly from: string;
  readonly to: string;
  readonly entries: readonly LedgerEntry[];
  readonly issues: readonly LedgerIssue[];
}
