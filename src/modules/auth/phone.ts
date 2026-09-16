import { env } from '../../config/env.js';
import { ValidationError } from '../../lib/errors.js';

// ITU-T E.164: up to 15 digits, never starting with 0.
const E164_DIGITS = /^[1-9]\d{7,14}$/;
const PHONE_CHARACTERS = /^[\d\s()+.-]+$/;

export interface PhoneRules {
  countryCode: string;
  nationalLength: number;
}

function configuredRules(): PhoneRules {
  return {
    countryCode: env.PHONE_DEFAULT_COUNTRY_CODE,
    nationalLength: env.PHONE_NATIONAL_NUMBER_LENGTH,
  };
}

/**
 * Normalises to E.164 digits without "+", so one person cannot end up with two
 * accounts through formatting differences.
 *
 * Without an international prefix, only the exact national length (or country
 * code + national length) is accepted. Anything else is ambiguous, and guessing
 * could silently attach someone to another person's account.
 */
export function normalizePhone(input: string, rules: PhoneRules = configuredRules()): string {
  const invalid = () =>
    new ValidationError('Enter a valid phone number.', { details: { field: 'phone' } });
  const trimmed = input.trim();
  if (!PHONE_CHARACTERS.test(trimmed)) throw invalid();

  const digits = trimmed.replace(/\D/g, '');
  let normalized: string;

  if (trimmed.startsWith('+')) {
    normalized = digits;
  } else if (digits.startsWith('00')) {
    normalized = digits.slice(2);
  } else {
    // A leading 0 is a domestic trunk prefix, not part of the number.
    const national = digits.replace(/^0+/, '');
    if (national.length === rules.nationalLength) {
      normalized = rules.countryCode + national;
    } else if (
      national.length === rules.countryCode.length + rules.nationalLength &&
      national.startsWith(rules.countryCode)
    ) {
      normalized = national;
    } else {
      throw invalid();
    }
  }

  if (!E164_DIGITS.test(normalized)) throw invalid();
  return normalized;
}
