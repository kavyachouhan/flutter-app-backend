/**
 * Money, as integer minor units (paise).
 *
 * Every amount in this system — database column, API field, intermediate
 * calculation — is a whole number of paise. Floating point never touches the
 * money path. `0.1 + 0.2 !== 0.3` is not a curiosity here: on a day of a few
 * hundred bills it is a cash drawer that does not reconcile, and on a GST
 * return it is a filing that does not match.
 *
 * Representation: `number`, not `bigint`. A JS number holds integers exactly
 * up to 2^53-1 paise — about ₹90,071,992,547,409 — which no SMB invoice or
 * lifetime tenant turnover will approach. `number` keeps the arithmetic
 * readable and serialises to JSON without a custom codec. The database stores
 * BIGINT, and `pg` is configured to return those as numbers with a range
 * assertion (see src/db/pool.ts).
 */

import { ValidationError } from './errors.js';

/** An integer number of paise. The branding is documentation, not enforcement. */
export type Paise = number;

/** ₹90 trillion. Anything beyond this is a data-entry error, not a sale. */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

export const PAISE_PER_RUPEE = 100;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Throws unless `value` is a safe integer. Call this at every boundary where
 * an amount enters the system, so a float can never get far enough to be
 * persisted or summed.
 */
export function assertPaise(value: number, field = 'amount'): Paise {
  if (!Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number.`, { details: { field, value } });
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(
      `${field} must be a whole number of paise, not a fractional value. ` + `Send ₹12.34 as 1234.`,
      { details: { field, value } },
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} is out of the supported range.`, {
      details: { field, value },
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Parses a decimal rupee string — "1234.56", "1,234.56", "₹1234.5" — into
 * paise, exactly.
 *
 * Deliberately string-based rather than `Math.round(parseFloat(s) * 100)`:
 * that route rounds 8.115 to 811 instead of 812 because the float nearest
 * 8.115 is slightly below it. Importing a supplier's price list through that
 * bug puts every affected item a paisa out, permanently.
 */
export function rupeesStringToPaise(input: string, field = 'amount'): Paise {
  const cleaned = input.trim().replace(/[₹,\s]/g, '');

  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new ValidationError(
      `${field} must be a decimal amount with at most two decimal places, e.g. "1234.56".`,
      { details: { field, value: input } },
    );
  }

  const [, sign, whole = '0', fraction = ''] = match;
  const paise = Number(whole) * PAISE_PER_RUPEE + Number(fraction.padEnd(2, '0'));

  if (!Number.isSafeInteger(paise)) {
    throw new ValidationError(`${field} is out of the supported range.`, {
      details: { field, value: input },
    });
  }

  return sign === '-' ? -paise : paise;
}

/**
 * Formats paise as a plain decimal string: `123456` → `"1234.56"`.
 * No currency symbol and no grouping — this is for receipts, exports and
 * tests, where the caller controls presentation. Localised display is the
 * client's job.
 */
export function paiseToRupeesString(paise: Paise): string {
  assertPaise(paise);
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const whole = Math.floor(absolute / PAISE_PER_RUPEE);
  const fraction = absolute % PAISE_PER_RUPEE;
  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * Rounds to the nearest integer, halves away from zero.
 *
 * This is the single rounding rule used by the whole tax engine, and it is
 * the convention Indian invoicing expects: ₹0.005 rounds up to ₹0.01, and
 * -0.5 rounds to -1 rather than to 0.
 *
 * `Math.round` is NOT equivalent — it rounds half *up* toward +Infinity, so
 * `Math.round(-0.5)` is `-0`, and credit notes would round in the opposite
 * direction from the invoices they reverse.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Applies a percentage to a paise amount and rounds to whole paise.
 * `percent` is a plain number: 18 for 18%, 2.5 for 2.5%.
 */
export function percentOf(amount: Paise, percent: number): Paise {
  assertPaise(amount);
  if (!Number.isFinite(percent)) {
    throw new ValidationError('Percentage must be a finite number.', { details: { percent } });
  }
  return roundHalfAwayFromZero((amount * percent) / 100);
}

/**
 * Round-off to the nearest rupee, as printed on the invoice.
 * Returns both the adjustment and the rounded total, because GST invoices
 * must show the round-off as its own line.
 */
export function roundToNearestRupee(amount: Paise): { rounded: Paise; adjustment: Paise } {
  assertPaise(amount);
  const rounded = roundHalfAwayFromZero(amount / PAISE_PER_RUPEE) * PAISE_PER_RUPEE;
  return { rounded, adjustment: rounded - amount };
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

/**
 * Splits `amount` across `weights` so the parts sum to exactly `amount`.
 *
 * The naive approach — round each share independently — loses or gains paise:
 * ₹100 split three ways becomes ₹99.99. This uses the largest-remainder
 * method, handing the leftover paise to the entries with the largest
 * fractional parts, so the total is preserved exactly and the distribution is
 * as fair as integer money allows.
 *
 * Used for apportioning a bill-level discount across lines, freight across
 * purchase lines (landed cost), and a payment across invoices.
 */
export function distribute(amount: Paise, weights: readonly number[]): Paise[] {
  assertPaise(amount);

  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new ValidationError('Distribution weights must be finite, non-negative numbers.');
  }

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // No weight to go on — spread as evenly as integer division allows, and give
  // the remainder to the leading entries.
  if (totalWeight === 0) {
    const base = Math.trunc(amount / weights.length);
    const shares = weights.map(() => base);
    let remainder = amount - base * weights.length;
    const step = remainder < 0 ? -1 : 1;
    for (let i = 0; remainder !== 0; i = (i + 1) % shares.length) {
      shares[i] = (shares[i] ?? 0) + step;
      remainder -= step;
    }
    return shares;
  }

  const exact = weights.map((w) => (amount * w) / totalWeight);
  const floored = exact.map((value) => Math.trunc(value));
  let remainder = amount - floored.reduce((sum, v) => sum + v, 0);

  // Rank by the size of the discarded fraction, largest first.
  const order = exact
    .map((value, index) => ({ index, fraction: Math.abs(value - Math.trunc(value)) }))
    .sort((a, b) => b.fraction - a.fraction);

  const step = remainder < 0 ? -1 : 1;
  for (let i = 0; remainder !== 0; i = (i + 1) % order.length) {
    const target = order[i % order.length];
    if (target === undefined) break;
    floored[target.index] = (floored[target.index] ?? 0) + step;
    remainder -= step;
  }

  return floored;
}

// ---------------------------------------------------------------------------
// Arithmetic helpers
//
// Thin, but they make intent explicit at call sites and give one place to add
// overflow assertions.
// ---------------------------------------------------------------------------

export function sum(amounts: readonly Paise[]): Paise {
  const total = amounts.reduce((acc, value) => acc + value, 0);
  return assertPaise(total, 'sum');
}

/** Quantities carry up to 3 decimals (grams, litres), so they scale by 1000. */
export const QUANTITY_SCALE = 1000;

/**
 * `unitPrice` (paise) × `quantity` (thousandths of a unit) → paise.
 * Rounded once, here, so a line total is never the sum of rounded sub-parts.
 */
export function lineAmount(unitPrice: Paise, quantityScaled: number): Paise {
  assertPaise(unitPrice, 'unitPrice');
  if (!Number.isSafeInteger(quantityScaled)) {
    throw new ValidationError('Quantity must be a whole number of thousandths.', {
      details: { quantityScaled },
    });
  }
  return roundHalfAwayFromZero((unitPrice * quantityScaled) / QUANTITY_SCALE);
}
