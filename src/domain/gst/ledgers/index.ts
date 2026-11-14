/**
 * Ledger parser registry: registry.json version id -> parser. A new portal format is one new
 * parser file, one line here and one registry row; nothing downstream changes.
 */
import { parseLedger } from './parse.js';
import type { LedgerKind, ParsedLedger } from './types.js';

export type LedgerParser = (document: unknown) => ParsedLedger;

export const LEDGER_PARSERS: Readonly<Record<string, LedgerParser>> = {
  'ledger-cash-v2026.11': (d) => parseLedger('cash', d),
  'ledger-liability-v2026.11': (d) => parseLedger('liability', d),
  'ledger-itc-reversal-v2026.11': (d) => parseLedger('itc_reversal', d),
};

/** The registry form (in data/gstn-schemas/registry.json) that holds each ledger's versions. */
export const LEDGER_FORM: Readonly<Record<LedgerKind, 'ledger_cash' | 'ledger_liability' | 'ledger_itc_reversal'>> = {
  cash: 'ledger_cash',
  liability: 'ledger_liability',
  itc_reversal: 'ledger_itc_reversal',
};

export * from './types.js';
