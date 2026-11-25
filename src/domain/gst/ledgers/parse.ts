/**
 * Parsers for the GSTN ledger responses, schema snapshot 2026-11 (`data/gstn-ledger`).
 *
 * Pure, and each reads a document the caller has already validated against the official schema.
 * A value that cannot be read becomes a reported issue and a null, never a guess.
 */
import type { TaxAmounts } from '../returns/model.js';
import type {
  HeadBreakup,
  LedgerDirection,
  LedgerEntry,
  LedgerIssue,
  LedgerKind,
  ParsedLedger,
  TaxHead,
} from './types.js';

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** Rupees as the portal writes them to whole paise, without float drift. */
export function toPaise(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function validDate(y: string, mo: string, d: string): string | null {
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const ok =
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d);
  return ok ? `${y}-${mo}-${d}` : null;
}

/** `dd/mm/yyyy`, `dd-mm-yyyy` or `yyyy-mm-dd` to ISO; null when it is none of those. */
export function parseGstnDate(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  let m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(s);
  if (m) return validDate(m[3] as string, m[2] as string, m[1] as string);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validDate(m[1] as string, m[2] as string, m[3] as string);
  return null;
}

/** `MMYYYY` to `YYYY-MM`. */
export function parseReturnPeriod(v: unknown): string | null {
  const s = asString(v);
  const m = s ? /^(\d{2})(\d{4})$/.exec(s) : null;
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
  return `${m[2]}-${m[1]}`;
}

function direction(v: unknown): LedgerDirection | null {
  const s = asString(v)?.toLowerCase();
  if (s === 'cr' || s === 'credit') return 'credit';
  if (s === 'dr' || s === 'debit') return 'debit';
  return null;
}

function breakup(v: unknown): HeadBreakup {
  const o = asObject(v);
  return {
    tax: toPaise(o['tx']),
    interest: toPaise(o['intr']),
    penalty: toPaise(o['pen']),
    other: toPaise(o['oth']),
    fee: toPaise(o['fee']),
  };
}

const headAmounts = (row: Json): Readonly<Record<TaxHead, HeadBreakup>> => ({
  igst: breakup(row['igst']),
  cgst: breakup(row['cgst']),
  sgst: breakup(row['sgst']),
  cess: breakup(row['cess']),
});

const four = (v: unknown): TaxAmounts => {
  const o = asObject(v);
  return {
    igst: toPaise(o['igst']),
    cgst: toPaise(o['cgst']),
    sgst: toPaise(o['sgst']),
    cess: toPaise(o['cess']),
  };
};

function windowOf(
  doc: Json,
  fromKey: string,
  toKey: string,
  issues: LedgerIssue[],
): { from: string; to: string } {
  const from = parseGstnDate(doc[fromKey]);
  const to = parseGstnDate(doc[toKey]);
  if (!from || !to) {
    issues.push({
      severity: 'error',
      code: 'ledger_window_unreadable',
      message: `The file's from and to dates (${String(doc[fromKey])}, ${String(doc[toKey])}) could not be read, so the period it covers is unknown.`,
    });
  }
  return { from: from ?? '', to: to ?? '' };
}

function tableRows(doc: Json): Json[] {
  const tr = doc['tr'];
  return Array.isArray(tr) ? tr.map(asObject) : [];
}

function checkEntry(
  row: number,
  date: string | null,
  dir: LedgerDirection | null,
  rawType: unknown,
  withDirection: boolean,
  issues: LedgerIssue[],
): void {
  if (!date) {
    issues.push({ severity: 'warning', code: 'entry_date_unreadable', rowNo: row, message: `Row ${row + 1}: the date could not be read.` });
  }
  if (withDirection && !dir) {
    issues.push({ severity: 'warning', code: 'entry_direction_unknown', rowNo: row, message: `Row ${row + 1}: the transaction type "${String(rawType)}" is neither credit nor debit.` });
  }
}

/** Cash ledger (`Get Cash Ledger Details`). */
function parseCash(doc: Json): ParsedLedger {
  const issues: LedgerIssue[] = [];
  const window = windowOf(doc, 'fr_dt', 'to_dt', issues);
  const entries: LedgerEntry[] = tableRows(doc).map((row, i) => {
    const date = parseGstnDate(row['dpt_dt']) ?? parseGstnDate(row['rpt_dt']);
    const dir = direction(row['tr_typ']);
    checkEntry(i, date, dir, row['tr_typ'], true, issues);
    return {
      kind: 'cash',
      rowNo: i,
      date,
      returnPeriod: parseReturnPeriod(row['ret_period']),
      refNo: asString(row['ref_no']) ?? asString(row['refNo']),
      description: asString(row['desc']) ?? '',
      direction: dir,
      dischargeType: null,
      amounts: headAmounts(row),
      itc: null,
    };
  });
  return { kind: 'cash', gstin: asString(doc['gstin']) ?? '', ...window, entries, issues };
}

/** Return-liability ledger (`Get Liability Ledger Details For Return Liability`). */
function parseLiability(doc: Json): ParsedLedger {
  const issues: LedgerIssue[] = [];
  const window = windowOf(doc, 'fr_dt', 'to_dt', issues);
  const entries: LedgerEntry[] = tableRows(doc).map((row, i) => {
    const date = parseGstnDate(row['dt']);
    const dir = direction(row['tr_typ']);
    checkEntry(i, date, dir, row['tr_typ'], true, issues);
    return {
      kind: 'liability',
      rowNo: i,
      date,
      returnPeriod: parseReturnPeriod(row['ret_period']),
      refNo: asString(row['ref_no']),
      description: asString(row['desc']) ?? '',
      direction: dir,
      dischargeType: asString(row['dschrg_typ']),
      amounts: headAmounts(row),
      itc: null,
    };
  });
  return { kind: 'liability', gstin: asString(doc['gstin']) ?? '', ...window, entries, issues };
}

/** Credit reversal and re-claim ledger. The key names say what each amount is, so nothing is guessed. */
function parseItcReversal(doc: Json): ParsedLedger {
  const issues: LedgerIssue[] = [];
  const window = windowOf(doc, 'frdt', 'todt', issues);
  const entries: LedgerEntry[] = tableRows(doc).map((row, i) => {
    const date = parseGstnDate(row['trandt']);
    checkEntry(i, date, null, null, false, issues);
    return {
      kind: 'itc_reversal',
      rowNo: i,
      date,
      returnPeriod: parseReturnPeriod(row['rtnprd']),
      refNo: asString(row['refno']),
      description: asString(row['desc']) ?? '',
      direction: null,
      dischargeType: null,
      amounts: null,
      itc: { reversed: four(row['itc4b2']), reclaimed: four(row['itc4d1']), availed: four(row['itc4a5']) },
    };
  });
  return { kind: 'itc_reversal', gstin: asString(doc['gstin']) ?? '', ...window, entries, issues };
}

export function parseLedger(kind: LedgerKind, document: unknown): ParsedLedger {
  const doc = asObject(document);
  switch (kind) {
    case 'cash':
      return parseCash(doc);
    case 'liability':
      return parseLiability(doc);
    case 'itc_reversal':
      return parseItcReversal(doc);
  }
}
