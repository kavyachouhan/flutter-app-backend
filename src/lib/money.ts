/**
 * Money is integer paise; quantities are integer thousandths of a unit.
 *
 * These two scales are part of the API and database contract with every
 * client, not tunables: changing either reinterprets all stored data.
 */
import { ValidationError } from './errors.js';

export type Paise = number;

export const PAISE_PER_RUPEE = 100;
export const QUANTITY_SCALE = 1000;

export function assertPaise(value: number, field = 'amount'): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be a whole number of paise.`, {
      details: { field, value },
    });
  }
  return value;
}

/**
 * Parses "1,234.56" / "₹1234.5" exactly. `Math.round(parseFloat(s) * 100)`
 * is not exact: 1.10 * 100 is 110.00000000000001, which is how imported price
 * lists end up a paisa off.
 */
export function rupeesStringToPaise(input: string, field = 'amount'): Paise {
  const cleaned = input.trim().replace(/[₹,\s]/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new ValidationError(
      `${field} must be a decimal amount with at most two decimal places.`,
      {
        details: { field, value: input },
      },
    );
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const paise = assertPaise(
    Number(whole) * PAISE_PER_RUPEE + Number(fraction.padEnd(2, '0')),
    field,
  );
  return sign === '-' ? -paise : paise;
}

export function paiseToRupeesString(paise: Paise): string {
  assertPaise(paise);
  const absolute = Math.abs(paise);
  const fraction = String(absolute % PAISE_PER_RUPEE).padStart(2, '0');
  return `${paise < 0 ? '-' : ''}${Math.floor(absolute / PAISE_PER_RUPEE)}.${fraction}`;
}

/**
 * The single rounding rule of the tax engine. `Math.round(-2.5)` is -2, so a
 * credit note would round the opposite way from the invoice it reverses.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function percentOf(amount: Paise, percent: number): Paise {
  assertPaise(amount);
  if (!Number.isFinite(percent)) {
    throw new ValidationError('Percentage must be a finite number.', { details: { percent } });
  }
  return roundHalfAwayFromZero((amount * percent) / 100);
}

/** GST invoices print the round-off as its own line, so both parts are returned. */
export function roundToNearestRupee(amount: Paise): { rounded: Paise; adjustment: Paise } {
  assertPaise(amount);
  const rounded = roundHalfAwayFromZero(amount / PAISE_PER_RUPEE) * PAISE_PER_RUPEE;
  return { rounded, adjustment: rounded - amount };
}

/**
 * Splits `amount` by `weights` so the parts sum to exactly `amount`, using the
 * largest-remainder method. Rounding each share independently loses or gains
 * paise (₹100 in three becomes ₹99.99).
 */
export function distribute(amount: Paise, weights: readonly number[]): Paise[] {
  assertPaise(amount);
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new ValidationError('Distribution weights must be finite, non-negative numbers.');
  }

  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  const exact =
    totalWeight === 0
      ? weights.map(() => amount / weights.length)
      : weights.map((w) => (amount * w) / totalWeight);

  const shares = exact.map((value) => Math.trunc(value));
  let remainder = amount - shares.reduce((acc, v) => acc + v, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: Math.abs(value - Math.trunc(value)) }))
    .sort((a, b) => b.fraction - a.fraction);

  const step = remainder < 0 ? -1 : 1;
  for (let i = 0; remainder !== 0; i = (i + 1) % order.length) {
    const target = order[i];
    if (!target) break;
    shares[target.index] = (shares[target.index] ?? 0) + step;
    remainder -= step;
  }

  return shares;
}

export function sum(amounts: readonly Paise[]): Paise {
  return assertPaise(
    amounts.reduce((acc, value) => acc + value, 0),
    'sum',
  );
}

/** Rounded once here, so a line total is never a sum of rounded sub-parts. */
export function lineAmount(unitPrice: Paise, quantityScaled: number): Paise {
  assertPaise(unitPrice, 'unitPrice');
  if (!Number.isSafeInteger(quantityScaled)) {
    throw new ValidationError('Quantity must be a whole number of thousandths.', {
      details: { quantityScaled },
    });
  }
  return roundHalfAwayFromZero((unitPrice * quantityScaled) / QUANTITY_SCALE);
}
