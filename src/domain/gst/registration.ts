/**
 * Which GST registration and which scheme govern a document on a date (D23), shared with
 * the Flutter app (`packages/khata_domain/lib/src/gst/registration.dart`).
 *
 * A document's registration is its outlet's. Settings that legally change over time
 * (composition, QRMP) live in effective-dated profiles; all ranges are half-open
 * `[effectiveFrom, effectiveTo)`.
 */
import { ValidationError } from '../../lib/errors.js';
import type {
  FilingFrequency,
  RegistrationKind,
  RegistrationStatus,
  TaxpayerScheme,
} from './enums.js';
import { isInForce, type Dated, type IsoDate } from './rule-set.js';

export interface RegistrationProfile extends Dated {
  readonly taxpayerScheme: TaxpayerScheme;
  readonly compositionCategory: string | null;
  readonly compositionRatePercent: number | null;
  readonly filingFrequency: FilingFrequency;
}

export interface RegistrationFacts extends Dated {
  readonly id: string;
  readonly gstin: string;
  readonly stateCode: string;
  readonly registrationKind: RegistrationKind;
  readonly isSezUnit: boolean;
  readonly isSezDeveloper: boolean;
  readonly status: RegistrationStatus;
  readonly profiles: readonly RegistrationProfile[];
}

/** The tax mode the engine applies; matches `invoices.tax_mode`. */
export type TaxMode = 'gst' | 'composition' | 'non_gst';

export function isRegistrationInForce(registration: RegistrationFacts, date: IsoDate): boolean {
  return isInForce(registration, date);
}

/** The single profile in force on `date`. The database excludes overlaps; a gap is an error. */
export function profileInForce(registration: RegistrationFacts, date: IsoDate): RegistrationProfile {
  const hits = registration.profiles.filter((p) => isInForce(p, date));
  if (hits.length !== 1) {
    throw new ValidationError(
      hits.length === 0
        ? `Registration ${registration.gstin} has no profile in force on ${date}.`
        : `Registration ${registration.gstin} has overlapping profiles on ${date}.`,
      { details: { registrationId: registration.id, date, matches: hits.length } },
    );
  }
  return hits[0]!;
}

/**
 * The tax mode for a document dated `date`: no registration, or one not yet (or no
 * longer) in force on that date, bills without GST; otherwise the profile's scheme.
 */
export function taxModeFor(registration: RegistrationFacts | null, date: IsoDate): TaxMode {
  if (registration === null || !isRegistrationInForce(registration, date)) return 'non_gst';
  return profileInForce(registration, date).taxpayerScheme === 'composition' ? 'composition' : 'gst';
}
