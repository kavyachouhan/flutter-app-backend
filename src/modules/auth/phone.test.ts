import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone, type PhoneRules } from './phone.js';
import { ValidationError } from '../../lib/errors.js';

const INDIA: PhoneRules = { countryCode: '91', nationalLength: 10 };

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '919876543210'],
    ['09876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['0091-98765-43210', '919876543210'],
    ['+1 (415) 555-2671', '14155552671'],
  ])('normalises %s', (input, expected) => {
    expect(normalizePhone(input, INDIA)).toBe(expected);
  });

  it.each(['12345', '98765432101234', 'abc', '98765 4321x', '+0123456789', ''])(
    'rejects %s',
    (input) => {
      expect(() => normalizePhone(input, INDIA)).toThrow(ValidationError);
    },
  );

  it('uses the national length it is given rather than a built-in one', () => {
    expect(normalizePhone('412345678', { countryCode: '61', nationalLength: 9 })).toBe(
      '61412345678',
    );
    expect(() => normalizePhone('412345678', INDIA)).toThrow(ValidationError);
  });
});

describe('maskPhone', () => {
  it('shows only the last digits behind a plus sign', () => {
    expect(maskPhone('919876543210')).toBe('+••••••••3210');
    expect(maskPhone('14155552671', 2)).toBe('+•••••••••71');
  });

  it('never reveals more than it has', () => {
    expect(maskPhone('123', 4)).toBe('+123');
  });
});
