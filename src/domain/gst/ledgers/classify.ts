/**
 * How a cash or liability ledger entry is read: as tax paid in cash, tax paid through credit, or
 * something to leave out.
 *
 * The ledgers describe a payment only in free text (`desc`) and a discharge code (`dschrg_typ`),
 * and the values those take are not in the schemas that were supplied. So the reading is DATA, a
 * rule set in `data/gstn-ledger/classification-rules.json` that starts empty, and every rule must
 * say what it was checked against. An entry no rule matches is counted and reported; it is never
 * placed in a head on a guess.
 */
import type { LedgerDirection, LedgerEntry, LedgerKind } from './types.js';

export type LedgerEffect = 'paid_cash' | 'paid_itc' | 'ignore';

export interface LedgerRule {
  readonly id: string;
  readonly kind: Exclude<LedgerKind, 'itc_reversal'>;
  /** Optional narrowing: every given condition must hold. */
  readonly direction?: LedgerDirection;
  /** A regular expression source, matched case-insensitively against the entry's description. */
  readonly descriptionPattern?: string;
  /** Matched case-insensitively against the liability ledger's discharge type. */
  readonly dischargeType?: string;
  readonly effect: LedgerEffect;
  /** The real ledger file, notice or portal screen this rule was checked against. Required. */
  readonly verifiedAgainst: string;
}

export interface LedgerRuleSet {
  readonly version: string;
  readonly rules: readonly LedgerRule[];
}

export const NO_RULES: LedgerRuleSet = { version: 'none', rules: [] };

/** The first rule whose conditions all hold, or null. */
export function classifyEntry(entry: LedgerEntry, rules: LedgerRuleSet): LedgerRule | null {
  for (const rule of rules.rules) {
    if (rule.kind !== entry.kind) continue;
    if (rule.direction !== undefined && rule.direction !== entry.direction) continue;
    if (
      rule.dischargeType !== undefined &&
      rule.dischargeType.toLowerCase() !== (entry.dischargeType ?? '').toLowerCase()
    ) {
      continue;
    }
    if (
      rule.descriptionPattern !== undefined &&
      !new RegExp(rule.descriptionPattern, 'i').test(entry.description)
    ) {
      continue;
    }
    return rule;
  }
  return null;
}

/** Rejects a rule set that would classify on nothing, or that does not say where it came from. */
export function validateRuleSet(raw: unknown): LedgerRuleSet {
  const o = (raw ?? {}) as { version?: unknown; rules?: unknown };
  if (typeof o.version !== 'string' || !Array.isArray(o.rules)) {
    throw new Error('Ledger rule set needs a version and a rules list.');
  }
  const rules = o.rules.map((r, i): LedgerRule => {
    const x = r as Partial<LedgerRule>;
    const where = `rule ${i + 1}${x.id ? ` (${x.id})` : ''}`;
    if (!x.id || (x.kind !== 'cash' && x.kind !== 'liability')) throw new Error(`${where}: needs an id and a kind of cash or liability.`);
    if (x.effect !== 'paid_cash' && x.effect !== 'paid_itc' && x.effect !== 'ignore') throw new Error(`${where}: effect must be paid_cash, paid_itc or ignore.`);
    if (!x.verifiedAgainst || x.verifiedAgainst.trim() === '') throw new Error(`${where}: verifiedAgainst is required, so a rule is never anonymous.`);
    if (x.direction === undefined && x.descriptionPattern === undefined && x.dischargeType === undefined) throw new Error(`${where}: needs at least one condition.`);
    if (x.descriptionPattern !== undefined) new RegExp(x.descriptionPattern, 'i'); // throws when malformed
    return x as LedgerRule;
  });
  return { version: o.version, rules };
}
