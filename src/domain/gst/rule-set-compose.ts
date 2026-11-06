/**
 * Turns the authored GST rule files (`data/gst-rules/`) into the complete dated snapshots the
 * engine reads (freeze §6). Law arrives as amendments, so it is authored as amendments: one file
 * per notification saying what it adds and what it ends. A version is everything in force up to
 * its date, with history kept in the entries. Server-side tooling only; devices receive snapshots.
 */
import type { GstRuleSetContent, IsoDate } from './rule-set.js';
import type { VerificationStatus } from './enums.js';

/** What a notification did to the rules, so every source document is accounted for. */
export type NotificationTreatment =
  /** Its rule changes are in this file. */
  | 'encoded'
  /** Read, and it changes nothing the engine evaluates (definitions, procedure). */
  | 'no_rule_impact'
  /** Changes rules, not encoded yet; `reason` says what is missing. */
  | 'deferred';

export type RuleCollection =
  | 'allowedRates'
  | 'taxRates'
  | 'thresholds'
  | 'rcmCategories'
  | 'blockedCredits'
  | 'einvoiceExclusions'
  | 'validationRules'
  | 'ewbIntraStateThresholds';

export const RULE_COLLECTIONS: readonly RuleCollection[] = [
  'allowedRates',
  'taxRates',
  'thresholds',
  'rcmCategories',
  'blockedCredits',
  'einvoiceExclusions',
  'validationRules',
  'ewbIntraStateThresholds',
];

/** An entry as authored: an id, its fields, and optionally its own dates or citation. */
export type AuthoredEntry = Record<string, unknown> & {
  readonly id: string;
  readonly effectiveFrom?: IsoDate;
  readonly effectiveTo?: IsoDate | null;
  readonly notificationRef?: string;
  readonly verificationStatus?: VerificationStatus;
};

export interface NotificationFile {
  /** e.g. "02/2026-CT(R)". Cited on every entry it adds. */
  readonly notification: string;
  readonly issued: IsoDate | null;
  readonly effectiveFrom: IsoDate;
  /** Source document under the repo, or null when no primary text is held yet. */
  readonly sourceFile: string | null;
  readonly verificationStatus: VerificationStatus;
  readonly treatment: NotificationTreatment;
  readonly reason?: string;
  readonly add?: Partial<Record<RuleCollection, readonly AuthoredEntry[]>>;
  /** Entries this notification ends, closed on its effective date. */
  readonly end?: Partial<Record<RuleCollection, readonly string[]>>;
  /** Replaces the cess block when the rule changes. */
  readonly cess?: Record<string, unknown>;
}

/** Reference data that is not dated law: state codes, UQC, 1A field lists. */
export interface RuleBaseFile {
  readonly stateCodes: GstRuleSetContent['stateCodes'];
  readonly uqc: GstRuleSetContent['uqc'];
  readonly gstr1aAmendableFields: GstRuleSetContent['gstr1aAmendableFields'];
}

export class RuleFileError extends Error {}

function byEffectiveDate(a: NotificationFile, b: NotificationFile): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
  return a.notification < b.notification ? -1 : a.notification > b.notification ? 1 : 0;
}

/** The dates a version exists for: every date on which some notification took effect with rules. */
export function versionDates(notifications: readonly NotificationFile[]): IsoDate[] {
  return [
    ...new Set(notifications.filter((n) => n.treatment === 'encoded').map((n) => n.effectiveFrom)),
  ].sort();
}

/** The complete snapshot of everything in force up to `date`, history included. */
export function composeRuleSet(
  base: RuleBaseFile,
  notifications: readonly NotificationFile[],
  date: IsoDate,
): GstRuleSetContent {
  const collected = new Map<RuleCollection, Map<string, Record<string, unknown>>>(
    RULE_COLLECTIONS.map((c) => [c, new Map()]),
  );
  let cess: Record<string, unknown> | undefined;

  for (const n of [...notifications].sort(byEffectiveDate)) {
    if (n.effectiveFrom > date || n.treatment !== 'encoded') continue;
    for (const collection of RULE_COLLECTIONS) {
      const target = collected.get(collection)!;
      for (const entry of n.add?.[collection] ?? []) {
        if (target.has(entry.id)) {
          throw new RuleFileError(`${n.notification}: ${collection} entry "${entry.id}" already exists`);
        }
        target.set(entry.id, {
          ...entry,
          effectiveFrom: entry.effectiveFrom ?? n.effectiveFrom,
          effectiveTo: entry.effectiveTo ?? null,
          notificationRef: entry.notificationRef ?? n.notification,
          verificationStatus: entry.verificationStatus ?? n.verificationStatus,
        });
      }
      for (const id of n.end?.[collection] ?? []) {
        const existing = target.get(id);
        if (!existing) {
          throw new RuleFileError(`${n.notification}: cannot end unknown ${collection} entry "${id}"`);
        }
        target.set(id, { ...existing, effectiveTo: n.effectiveFrom });
      }
    }
    if (n.cess) {
      cess = {
        notificationRef: n.notification,
        verificationStatus: n.verificationStatus,
        history: [],
        ...n.cess,
      };
    }
  }
  if (!cess) throw new RuleFileError(`No cess rule in force on ${date}`);

  const list = (c: RuleCollection): Record<string, unknown>[] => [...collected.get(c)!.values()];
  return {
    allowedRates: list('allowedRates'),
    taxRates: list('taxRates'),
    cess,
    thresholds: list('thresholds'),
    stateCodes: base.stateCodes,
    uqc: base.uqc,
    rcmCategories: list('rcmCategories'),
    blockedCredits: list('blockedCredits'),
    einvoiceExclusions: list('einvoiceExclusions'),
    validationRules: list('validationRules'),
    gstr1aAmendableFields: base.gstr1aAmendableFields,
    ewbIntraStateThresholds: list('ewbIntraStateThresholds'),
  } as unknown as GstRuleSetContent;
}

/** A problem with a composed snapshot, in words the author of the file can act on. */
export function ruleSetProblems(content: GstRuleSetContent): string[] {
  const problems: string[] = [];
  for (const r of content.taxRates) {
    if ((r.taxability === 'taxable') !== (r.ratePercent !== null)) {
      problems.push(`taxRates "${r.id}": a rate is required exactly when taxability is taxable`);
    }
    if (r.taxability !== 'taxable' && r.taxability !== 'non_gst' && !r.exemptionBasis) {
      problems.push(`taxRates "${r.id}": a nil-rated or exempt entry must name its exemption basis`);
    }
    if (r.scope.codePrefixes.length === 0) problems.push(`taxRates "${r.id}": no HSN/SAC prefixes`);
    for (const prefix of [...r.scope.codePrefixes, ...(r.scope.excludePrefixes ?? [])]) {
      if (!/^\d{2,8}$/.test(prefix)) problems.push(`taxRates "${r.id}": bad code prefix "${prefix}"`);
    }
    if (r.rcmCategoryCode && !content.rcmCategories.some((c) => c.code === r.rcmCategoryCode)) {
      problems.push(`taxRates "${r.id}": unknown RCM category "${r.rcmCategoryCode}"`);
    }
  }
  // Two thresholds of one key must never both be in force: the evaluator refuses that at runtime.
  const thresholds = [...content.thresholds].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  for (let i = 0; i < thresholds.length; i++) {
    for (let j = i + 1; j < thresholds.length; j++) {
      const [a, b] = [thresholds[i]!, thresholds[j]!];
      if (a.key === b.key && (a.effectiveTo === null || b.effectiveFrom < a.effectiveTo)) {
        problems.push(`thresholds: "${a.key}" overlaps from ${b.effectiveFrom}`);
      }
    }
  }
  return problems;
}

/**
 * The rate entries in force on `date` that rest only on secondary sources. A version may not be
 * published while any remain (freeze §6.4): no rate is frozen from commentary.
 */
export function unverifiedRates(content: GstRuleSetContent, date: IsoDate): string[] {
  const inForce = (e: { effectiveFrom: IsoDate; effectiveTo: IsoDate | null }): boolean =>
    e.effectiveFrom <= date && (e.effectiveTo === null || date < e.effectiveTo);
  return [
    ...content.allowedRates
      .filter((r) => inForce(r) && r.verificationStatus !== 'primary_verified')
      .map((r) => `allowed rate ${r.ratePercent}% (${r.notificationRef})`),
    ...content.taxRates
      .filter((r) => inForce(r) && r.verificationStatus !== 'primary_verified')
      .map((r) => `tax rate "${r.id}" (${r.notificationRef})`),
  ];
}

export interface HsnRow {
  readonly code: string;
  readonly kind: 'goods' | 'service';
  readonly description: string;
  readonly parentCode: string | null;
}

export interface HsnCorrection {
  readonly raw: string;
  readonly code: string;
  readonly fix: 'spaces_removed' | 'leading_zero_restored' | 'left_out_for_proper_code';
}

/**
 * Prepares the GSTN HSN/SAC download for loading. The download holds a few rows whose code is not a
 * valid HSN form: no leading zero (`40210`) or a space (`2307 00`), each beside a row with the proper
 * code (`040210`). The portal's HSN search finds `040210` and not `40210`, so the properly formed row
 * is the one kept and the other is left out. Everything left out or changed is reported, and a code
 * that makes no sense at all stops the load.
 */
export function normaliseHsnMaster(
  raw: readonly { readonly code: string | number; readonly description: string; readonly kind: HsnRow['kind'] }[],
): { rows: HsnRow[]; corrections: HsnCorrection[]; errors: string[] } {
  const corrections: HsnCorrection[] = [];
  const errors: string[] = [];
  const clean = new Map<string, { kind: HsnRow['kind']; description: string }>();

  const repairOf = (original: string): string => {
    const compact = original.replace(/\s+/g, '');
    return /^\d+$/.test(compact) && compact.length % 2 === 1 ? `0${compact}` : compact;
  };
  const wellFormedFirst = [...raw]
    .map((r) => ({ ...r, original: String(r.code).trim() }))
    .sort((a, b) => Number(repairOf(a.original) !== a.original) - Number(repairOf(b.original) !== b.original));

  for (const r of wellFormedFirst) {
    const { original } = r;
    const code = repairOf(original);
    if (code !== original) {
      if (clean.has(code)) {
        corrections.push({ raw: original, code, fix: 'left_out_for_proper_code' });
        continue;
      }
      corrections.push({
        raw: original,
        code,
        fix: /\s/.test(original) ? 'spaces_removed' : 'leading_zero_restored',
      });
    }
    const description = r.description.replace(/\s+/g, ' ').trim();
    if (!/^\d{2,8}$/.test(code) || code.length % 2 === 1) {
      errors.push(`Unusable code "${original}"`);
      continue;
    }
    if (description === '') {
      errors.push(`Code ${code} has no description`);
      continue;
    }
    if (clean.has(code)) {
      errors.push(`Duplicate code ${code}`);
      continue;
    }
    clean.set(code, { kind: r.kind, description });
  }

  const rows: HsnRow[] = [];
  for (const [code, { kind, description }] of clean) {
    let parentCode: string | null = null;
    for (let length = code.length - 2; length >= 2; length -= 2) {
      if (clean.has(code.slice(0, length))) {
        parentCode = code.slice(0, length);
        break;
      }
    }
    rows.push({ code, kind, description, parentCode });
  }
  return { rows, corrections, errors };
}
