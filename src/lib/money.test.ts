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
  it('parses decorated decimals exactly', () => {
    expect(rupeesStringToPaise('1,234.56')).toBe(123456);
    expect(rupeesStringToPaise('₹1234.5')).toBe(123450);
    expect(rupeesStringToPaise('-99.99')).toBe(-9999);
    // parseFloat('1.10') * 100 is 110.00000000000001
    expect(rupeesStringToPaise('1.10')).toBe(110);
  });

  it('rejects more than two decimals instead of truncating', () => {
    expect(() => rupeesStringToPaise('8.115')).toThrow(ValidationError);
    expect(() => rupeesStringToPaise('abc')).toThrow(ValidationError);
  });

  it('round-trips with the formatter', () => {
    for (const value of [0, 7, 110, 12345, -12345]) {
      expect(rupeesStringToPaise(paiseToRupeesString(value))).toBe(value);
    }
  });
});

describe('rounding', () => {
  it('rounds halves away from zero, unlike Math.round', () => {
    expect([0.5, 2.5, -0.5, -2.5].map(roundHalfAwayFromZero)).toEqual([1, 3, -1, -3]);
    expect(Math.round(-2.5)).toBe(-2);
  });

  it('applies percentages and rupee round-off', () => {
    expect(percentOf(999, 5)).toBe(50);
    expect(roundToNearestRupee(12345)).toEqual({ rounded: 12300, adjustment: -45 });
    expect(roundToNearestRupee(12350)).toEqual({ rounded: 12400, adjustment: 50 });
  });
});

describe('distribute', () => {
  it('preserves the total exactly', () => {
    expect(distribute(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(distribute(1000, [50, 30, 20])).toEqual([500, 300, 200]);
    expect(sum(distribute(101, [0, 0, 0]))).toBe(101);
    expect(sum(distribute(-1000, [1, 1, 3]))).toBe(-1000);
    expect(distribute(500, [])).toEqual([]);
  });

  it('never loses a paisa across many inputs', () => {
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
  it('multiplies price by thousandths and rounds once', () => {
    expect(lineAmount(9999, 2500)).toBe(24998);
    expect(lineAmount(40000, 125)).toBe(5000);
  });
});
