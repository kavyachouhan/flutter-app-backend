/**
 * The dated GST rule set (D18) and its evaluator, shared with the Flutter app
 * (`packages/khata_domain/lib/src/gst/rule_set.dart`). Frozen by
 * docs/gst/A0A_ARCHITECTURE_FREEZE.md §6.
 *
 * A version is a complete snapshot of the rules in force from its `effectiveFrom` until
 * the next published `effectiveFrom`. Inside it, every entry carries its own dates, so
 * one version can describe a rule that ends (cess) or begins mid-period. Dates are ISO
 * `YYYY-MM-DD` strings, which compare correctly as strings; `effectiveTo` is exclusive.
 */
import { ErrorCode, UnprocessableError, ValidationError } from '../../lib/errors.js';
import type {
  EinvoiceExemptionCategory,
  RuleSetStatus,
  Taxability,
  TaxRateConditionKey,
  ThresholdKey,
  VerificationStatus,
} from './enums.js';

export type IsoDate = string;

export interface RuleRef {
  readonly notificationRef: string;
  readonly verificationStatus: VerificationStatus;
}

export interface Dated {
  readonly effectiveFrom: IsoDate;
  /** Exclusive; null means open-ended. */
  readonly effectiveTo: IsoDate | null;
}

export interface AllowedRateEntry extends RuleRef, Dated {
  readonly ratePercent: number;
}

export type CodeKind = 'hsn' | 'sac';

export interface TaxRateEntry extends RuleRef, Dated {
  readonly id: string;
  readonly scope: {
    readonly kind: CodeKind;
    readonly codePrefixes: readonly string[];
    readonly excludePrefixes?: readonly string[];
  };
  readonly taxability: Taxability;
  /** Required iff taxability is 'taxable'. */
  readonly ratePercent: number | null;
  readonly condition: null | {
    readonly key: TaxRateConditionKey;
    /** Paise per unit for the value conditions; null for manual_selection. */
    readonly value: number | null;
    readonly description: string;
  };
  readonly exemptionBasis: string | null;
  readonly rcmCategoryCode: string | null;
}

export interface CessHistoryEntry extends RuleRef, Dated {
  readonly scope: { readonly kind: 'hsn'; readonly codePrefixes: readonly string[] };
  readonly adValoremPercent: number | null;
  readonly specificPerUnit: { readonly amountPaise: number; readonly uqc: string } | null;
  readonly compound: 'max' | 'sum' | null;
}

export interface ThresholdEntry extends RuleRef, Dated {
  readonly key: ThresholdKey;
  readonly value: number;
}

export interface ValidationRuleEntry extends RuleRef, Dated {
  readonly id: string;
  readonly returnType: string;
  readonly check: string;
  readonly enforcement: 'warn' | 'block';
}

export interface GstRuleSetContent {
  readonly allowedRates: readonly AllowedRateEntry[];
  readonly taxRates: readonly TaxRateEntry[];
  readonly cess: RuleRef & {
    /** Last day (inclusive) on which a new document may charge cess. */
    readonly allowedUntil: IsoDate;
    readonly history: readonly CessHistoryEntry[];
  };
  readonly thresholds: readonly ThresholdEntry[];
  readonly stateCodes: readonly {
    readonly code: string;
    readonly name: string;
    readonly isUnionTerritoryWithoutLegislature: boolean;
  }[];
  readonly uqc: readonly { readonly code: string; readonly description: string; readonly unitAliases: readonly string[] }[];
  readonly rcmCategories: readonly (RuleRef &
    Dated & {
      readonly code: string;
      readonly description: string;
      readonly direction: 'goods' | 'services';
      readonly recipientMustBe: string;
    })[];
  readonly blockedCredits: readonly (RuleRef &
    Dated & { readonly code: string; readonly description: string; readonly section: string })[];
  readonly einvoiceExclusions: readonly (RuleRef & Dated & { readonly category: EinvoiceExemptionCategory })[];
  readonly validationRules: readonly ValidationRuleEntry[];
  readonly gstr1aAmendableFields: Readonly<Record<string, readonly string[]>>;
  readonly ewbIntraStateThresholds: readonly (RuleRef &
    Dated & { readonly stateCode: string; readonly value: number })[];
}

export interface GstRuleSet {
  readonly version: string;
  readonly effectiveFrom: IsoDate;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly status: RuleSetStatus;
  readonly content: GstRuleSetContent;
}

export const LEGACY_RULE_SET_VERSION = 'legacy';

export function isInForce(entry: Dated, date: IsoDate): boolean {
  return entry.effectiveFrom <= date && (entry.effectiveTo === null || date < entry.effectiveTo);
}

function unavailable(message: string, details: Record<string, unknown>): UnprocessableError {
  return new UnprocessableError(message, ErrorCode.RULE_SET_UNAVAILABLE, { details });
}

/**
 * The single version in force on `date`: among published versions starting on or
 * before it, the latest `effectiveFrom`, then the highest revision. Drafts, withdrawn
 * versions and the `legacy` label are never candidates.
 */
export function selectRuleSet(date: IsoDate, versions: readonly GstRuleSet[]): GstRuleSet {
  let best: GstRuleSet | undefined;
  for (const v of versions) {
    if (v.status !== 'published' || v.effectiveFrom > date) continue;
    if (
      best === undefined ||
      v.effectiveFrom > best.effectiveFrom ||
      (v.effectiveFrom === best.effectiveFrom && v.revision > best.revision)
    ) {
      best = v;
    }
  }
  if (best === undefined) {
    throw unavailable(`No published GST rule set covers ${date}.`, { date });
  }
  return best;
}

/** The `legacy` label marks migrated documents; it encodes no rules and is never evaluated. */
function evaluable(ruleSet: GstRuleSet): GstRuleSetContent {
  if (ruleSet.status === 'legacy' || ruleSet.version === LEGACY_RULE_SET_VERSION) {
    throw new ValidationError('The legacy rule set is a label and cannot be evaluated.', {
      details: { version: ruleSet.version },
    });
  }
  return ruleSet.content;
}

/** The one threshold value in force for `key` on `date`. */
export function thresholdValue(ruleSet: GstRuleSet, key: ThresholdKey, date: IsoDate): number {
  const hits = evaluable(ruleSet).thresholds.filter((t) => t.key === key && isInForce(t, date));
  if (hits.length !== 1) {
    throw unavailable(
      hits.length === 0
        ? `Rule set ${ruleSet.version} has no ${key} threshold for ${date}.`
        : `Rule set ${ruleSet.version} has overlapping ${key} thresholds for ${date}.`,
      { version: ruleSet.version, key, date, matches: hits.length },
    );
  }
  return hits[0]!.value;
}

export function isRateAllowed(ruleSet: GstRuleSet, ratePercent: number, date: IsoDate): boolean {
  return evaluable(ruleSet).allowedRates.some((r) => r.ratePercent === ratePercent && isInForce(r, date));
}

/** Cess may be charged on a new document only up to and including `allowedUntil`. */
export function isCessAllowed(ruleSet: GstRuleSet, date: IsoDate): boolean {
  return date <= evaluable(ruleSet).cess.allowedUntil;
}

/** The enforcement of a validation rule on `date`, or null when it is not switched on. */
export function validationEnforcement(
  ruleSet: GstRuleSet,
  id: string,
  date: IsoDate,
): 'warn' | 'block' | null {
  const rule = evaluable(ruleSet).validationRules.find((r) => r.id === id && isInForce(r, date));
  return rule?.enforcement ?? null;
}

function longestPrefixMatch(code: string, prefixes: readonly string[]): number {
  let best = 0;
  for (const p of prefixes) {
    if (code.startsWith(p) && p.length > best) best = p.length;
  }
  return best;
}

/**
 * Candidate rate entries for an HSN/SAC on `date`: entries in force whose scope kind
 * matches and whose prefixes match (minus carve-outs), keeping only the longest
 * matching prefix. Several candidates remain when conditions differ. Sorted by id so
 * both ports return the same order.
 */
export function ratesFor(
  ruleSet: GstRuleSet,
  kind: CodeKind,
  code: string,
  date: IsoDate,
): readonly TaxRateEntry[] {
  let bestLength = 0;
  let matches: TaxRateEntry[] = [];
  for (const entry of evaluable(ruleSet).taxRates) {
    if (entry.scope.kind !== kind || !isInForce(entry, date)) continue;
    if (entry.scope.excludePrefixes && longestPrefixMatch(code, entry.scope.excludePrefixes) > 0) continue;
    const length = longestPrefixMatch(code, entry.scope.codePrefixes);
    if (length === 0) continue;
    if (length > bestLength) {
      bestLength = length;
      matches = [entry];
    } else if (length === bestLength) {
      matches.push(entry);
    }
  }
  return matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function conditionHolds(entry: TaxRateEntry, unitValue: number | null): boolean {
  const condition = entry.condition;
  if (condition === null || condition.key === 'manual_selection') return true;
  if (unitValue === null || condition.value === null) return false;
  return condition.key === 'unit_value_at_most' ? unitValue <= condition.value : unitValue > condition.value;
}

export interface LineRateInput {
  readonly kind: CodeKind;
  /** Null when the line has no HSN/SAC. */
  readonly code: string | null;
  readonly supplyCategory: Taxability;
  readonly ratePercent: number;
  /** Paise per unit, for value conditions; null when unknown. */
  readonly unitValue: number | null;
}

export type LineRateCheck =
  | { readonly outcome: 'match'; readonly entryId: string; readonly manualSelection: boolean }
  | { readonly outcome: 'mismatch'; readonly candidateIds: readonly string[] }
  | { readonly outcome: 'unmapped'; readonly rateAllowed: boolean };

/**
 * Whether a line's (supply category, rate) is one the rule set allows for its HSN/SAC.
 * Non-taxable categories match on taxability alone, because the catalogue rate a
 * nil-rated or exempt line still carries is informational. With no HSN, or no entry
 * covering it, the rate is only checked against the notified slabs (`unmapped`).
 */
export function checkLineRate(ruleSet: GstRuleSet, line: LineRateInput, date: IsoDate): LineRateCheck {
  const candidates = line.code === null ? [] : ratesFor(ruleSet, line.kind, line.code, date);
  if (candidates.length === 0) {
    return {
      outcome: 'unmapped',
      rateAllowed: line.supplyCategory !== 'taxable' || isRateAllowed(ruleSet, line.ratePercent, date),
    };
  }
  for (const c of candidates) {
    if (c.taxability !== line.supplyCategory) continue;
    if (c.taxability === 'taxable' && c.ratePercent !== line.ratePercent) continue;
    if (!conditionHolds(c, line.unitValue)) continue;
    return { outcome: 'match', entryId: c.id, manualSelection: c.condition?.key === 'manual_selection' };
  }
  return { outcome: 'mismatch', candidateIds: candidates.map((c) => c.id) };
}
