/**
 * Picks the mapper version for a form and return period from `data/gstn-schemas/registry.json`.
 * Pure: the file is read by the caller, so this is testable and a format change is a data edit.
 */
import type { MapperVerification } from './mappers/types.js';
import type { ReturnPeriod } from './model.js';

export type RegistryForm =
  | 'gstr1'
  | 'gstr3b'
  | 'gstr9'
  | 'gstr2b'
  | 'ledger_cash'
  | 'ledger_liability'
  | 'ledger_itc_reversal';

export type ValidationSpec =
  | { readonly kind: 'single'; readonly schema: string }
  | { readonly kind: 'sections'; readonly sections: Readonly<Record<string, string>> };

export interface RegistryVersion {
  readonly id: string;
  /** Return period `YYYY-MM`, inclusive; null = unbounded. */
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly verification: MapperVerification;
  readonly schemaSnapshot: string;
  readonly validation: ValidationSpec;
  readonly serverPopulatedFields?: readonly string[];
  readonly unsupportedSections?: readonly string[];
  readonly samples?: string;
  readonly notes?: string;
}

export interface SchemaRegistry {
  readonly forms: Readonly<Record<string, { readonly versions: readonly RegistryVersion[] }>>;
}

export function periodKey(period: ReturnPeriod): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`;
}

/**
 * The version in force for a period. Overlapping or missing coverage is a registry error, not a
 * guess: exporting under the wrong format is worse than refusing.
 */
export function selectVersion(
  registry: SchemaRegistry,
  form: RegistryForm,
  period: ReturnPeriod,
): RegistryVersion {
  const key = periodKey(period);
  const versions = registry.forms[form]?.versions ?? [];
  const matches = versions.filter(
    (v) =>
      (v.effectiveFrom === null || v.effectiveFrom <= key) &&
      (v.effectiveTo === null || key <= v.effectiveTo),
  );
  if (matches.length === 0) {
    throw new RegistryError(`No ${form} format is registered for return period ${key}.`);
  }
  if (matches.length > 1) {
    throw new RegistryError(
      `Overlapping ${form} formats for ${key}: ${matches.map((m) => m.id).join(', ')}.`,
    );
  }
  return matches[0] as RegistryVersion;
}

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}
