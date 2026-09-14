import { describe, expect, it } from 'vitest';
import {
  distribute,
  lineAmount,
  paiseToRupeesString,
  percentOf,
  roundHalfAwayFromZero,
  roundToNearestRupee,
  rupeesStringToPaise,
  sum,
} from './money.js';
import { ValidationError } from './errors.js';

describe('rupeesStringToPaise', () => {
  it('parses plain and decorated decimal strings', () => {
    expect(rupeesStringToPaise('0')).toBe(0);
    expect(rupeesStringToPaise('1234.56')).toBe(123456);
    expect(rupeesStringToPaise('1,234.56')).toBe(123456);
    expect(rupeesStringToPaise('₹1234.5')).toBe(123450);
    expect(rupeesStringToPaise('-99.99')).toBe(-9999);
  });

  it('is exact where float parsing is not', () => {
    // parseFloat('1.10') * 100 is 110.00000000000001, and 0.07 * 100 is
    // 7.000000000000001. String parsing has no such problem.
    expect(rupeesStringToPaise('1.10')).toBe(110);
    expect(rupeesStringToPaise('0.07')).toBe(7);
    expect(rupeesStringToPaise('8.12')).toBe(812);
    expect(rupeesStringToPaise('29.99')).toBe(2999);
  });

  it('rejects more than two decimal places rather than silently truncating', () => {
    expect(() => rupeesStringToPaise('8.115')).toThrow(ValidationError);
    expect(() => rupeesStringToPaise('abc')).toThrow(ValidationError);
    expect(() => rupeesStringToPaise('')).toThrow(ValidationError);
  });
});

describe('paiseToRupeesString', () => {
  it('always emits two decimal places', () => {
    expect(paiseToRupeesString(0)).toBe('0.00');
    expect(paiseToRupeesString(7)).toBe('0.07');
    expect(paiseToRupeesString(110)).toBe('1.10');
    expect(paiseToRupeesString(123456)).toBe('1234.56');
    expect(paiseToRupeesString(-9999)).toBe('-99.99');
  });

  it('round-trips with the parser', () => {
    for (const value of [0, 1, 99, 100, 12345, -12345, 999999999]) {
      expect(rupeesStringToPaise(paiseToRupeesString(value))).toBe(value);
    }
  });
});

describe('roundHalfAwayFromZero', () => {
  it('sends halves away from zero in both directions', () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(1.5)).toBe(2);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
  });

  it('differs from Math.round on negative halves, which is the whole point', () => {
    // A credit note must round the same magnitude as the invoice it reverses.
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(Math.round(-2.5)).toBe(-2);
  });
});

describe('percentOf', () => {
  it('computes GST rates', () => {
    expect(percentOf(10000, 18)).toBe(1800);
    expect(percentOf(10000, 2.5)).toBe(250);
    expect(percentOf(10000, 0)).toBe(0);
    expect(percentOf(999, 5)).toBe(50); // 49.95 -> 50
  });
});

describe('roundToNearestRupee', () => {
  it('returns the adjustment separately so it can be printed as a line', () => {
    expect(roundToNearestRupee(12345)).toEqual({ rounded: 12300, adjustment: -45 });
    expect(roundToNearestRupee(12355)).toEqual({ rounded: 12400, adjustment: 45 });
    expect(roundToNearestRupee(12350)).toEqual({ rounded: 12400, adjustment: 50 });
    expect(roundToNearestRupee(12300)).toEqual({ rounded: 12300, adjustment: 0 });
  });
});

describe('distribute', () => {
  it('preserves the total exactly when it does not divide evenly', () => {
    const shares = distribute(10000, [1, 1, 1]);
    expect(sum(shares)).toBe(10000);
    expect(shares).toEqual([3334, 3333, 3333]);
  });

  it('apportions by weight', () => {
    const shares = distribute(1000, [50, 30, 20]);
    expect(shares).toEqual([500, 300, 200]);
    expect(sum(shares)).toBe(1000);
  });

  it('gives the leftover paise to the largest fractional remainders', () => {
    // 100 paise over weights 1:1:1 -> 33.33 each, one paisa to hand out.
    const shares = distribute(100, [1, 1, 1]);
    expect(sum(shares)).toBe(100);
    expect(shares.filter((s) => s === 34)).toHaveLength(1);
  });

  it('handles zero total weight without dropping money', () => {
    const shares = distribute(101, [0, 0, 0]);
    expect(sum(shares)).toBe(101);
  });

  it('handles negative amounts (returns, credit notes)', () => {
    const shares = distribute(-1000, [1, 1, 3]);
    expect(sum(shares)).toBe(-1000);
    expect(shares.every((s) => s <= 0)).toBe(true);
  });

  it('returns an empty array for no weights', () => {
    expect(distribute(500, [])).toEqual([]);
  });

  it('never loses a paisa across a wide range of inputs', () => {
    for (let amount = 1; amount <= 500; amount += 7) {
      for (const weights of [
        [1, 2],
        [1, 1, 1],
        [7, 11, 13, 17],
        [5, 0, 5],
      ]) {
        expect(sum(distribute(amount, weights))).toBe(amount);
      }
    }
  });
});

describe('lineAmount', () => {
  it('rounds once, at the line', () => {
    // 2.5 kg at ₹99.99
    expect(lineAmount(9999, 2500)).toBe(24998); // 24997.5 -> 24998
    expect(lineAmount(6000, 2000)).toBe(12000);
    expect(lineAmount(2500, 3000)).toBe(7500);
  });

  it('supports three-decimal quantities', () => {
    // 0.125 kg at ₹400/kg = ₹50
    expect(lineAmount(40000, 125)).toBe(5000);
  });
});
