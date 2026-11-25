/**
 * GSTIN and UIN validation, shared with the Flutter app
 * (`packages/khata_domain/lib/src/gst/gstin.dart`) and with SQL (`app.gstin_valid()`,
 * migration 0037). All three must agree on every case in `contracts/gstin-vectors.json`.
 *
 * A GSTIN is 15 characters: state code (2) + PAN (10) + entity number (1) + 'Z' +
 * check character. The check character is the GSTN mod-36 checksum over the first 14.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * State codes a GSTIN may start with: 01–38, 97 (Other Territory) and 99 (Centre
 * Jurisdiction). Codes 25 and 28 are retired but older registrations still carry them,
 * so the whole 01–38 range is accepted. 96 (Foreign Country) is a place of supply,
 * never a registration.
 */
export function isGstinStateCode(code: string): boolean {
  if (!/^[0-9]{2}$/.test(code)) return false;
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}

/** The check character for the first 14 characters of a GSTIN. */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14.charAt(i));
    // Weights alternate 1, 2 from the left; the product is folded base 36.
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET.charAt((36 - (sum % 36)) % 36);
}

export type GstinProblem = 'format' | 'state_code' | 'checksum';

/** Why a GSTIN is invalid, or `null` when it is valid. Input is not normalised. */
export function gstinProblem(gstin: string): GstinProblem | null {
  if (!GSTIN_FORMAT.test(gstin)) return 'format';
  if (!isGstinStateCode(gstin.slice(0, 2))) return 'state_code';
  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'checksum';
  return null;
}

export function isGstinValid(gstin: string): boolean {
  return gstinProblem(gstin) === null;
}

/** Upper-cases and strips spaces, the only normalisation a typed GSTIN gets. */
export function normaliseGstin(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** True when a party's declared state agrees with its GSTIN's prefix. */
export function gstinMatchesState(gstin: string, stateCode: string): boolean {
  return gstin.slice(0, 2) === stateCode;
}

/**
 * UIN (UN bodies, embassies, other notified persons). Format only, no checksum and no
 * state-prefix rule. Provisional until freeze open item U1 is settled: 15 upper-case
 * alphanumerics.
 */
export function isUinFormatValid(uin: string): boolean {
  return /^[0-9A-Z]{15}$/.test(uin);
}
