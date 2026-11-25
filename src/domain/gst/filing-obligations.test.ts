import { describe, expect, it } from 'vitest';
import { b2clThresholdPaise } from './classify.js';
import {
  ANNUAL_RETURN_EXEMPTION_LIMIT_PAISE,
  annualReturnObligation,
  isTimeBarred,
  standardDueDate,
  timeBarredFrom,
} from './filing-obligations.js';

describe('B2CL threshold by date', () => {
  it('is ₹2.5 lakh up to 31.07.2024 and ₹1 lakh from 01.08.2024', () => {
    expect(b2clThresholdPaise('2024-07-31')).toBe(25_000_000);
    expect(b2clThresholdPaise('2024-08-01')).toBe(10_000_000);
    expect(b2clThresholdPaise('2026-11-25T10:00:00Z')).toBe(10_000_000);
  });
});

describe('annual return obligation', () => {
  it('is optional at or below ₹2 crore and required above, citing the year’s notification', () => {
    const at = annualReturnObligation(2024, ANNUAL_RETURN_EXEMPTION_LIMIT_PAISE);
    expect(at.status).toBe('optional');
    expect(at.basis).toContain('15/2025-CT');
    expect(annualReturnObligation(2024, ANNUAL_RETURN_EXEMPTION_LIMIT_PAISE + 1).status).toBe('required');
    expect(annualReturnObligation(2022, 1).basis).toContain('32/2023-CT');
    expect(annualReturnObligation(2023, 1).basis).toContain('14/2024-CT');
    expect(annualReturnObligation(2030, 1).basis).toContain('15/2025-CT');
  });

  it('is unknown without a turnover or before FY 2022-23', () => {
    expect(annualReturnObligation(2024, null).status).toBe('unknown');
    expect(annualReturnObligation(2021, 1).status).toBe('unknown');
  });
});

describe('due dates and the three-year bar', () => {
  it('computes standard due dates', () => {
    expect(standardDueDate('gstr1', 2024, 12, 'monthly')).toBe('2025-01-11');
    expect(standardDueDate('gstr1', 2024, 6, 'qrmp')).toBe('2024-07-13');
    expect(standardDueDate('gstr3b', 2024, 5, 'monthly')).toBe('2024-06-20');
    expect(standardDueDate('gstr3b', 2024, 9, 'qrmp')).toBe('2024-10-24');
    // GSTR-9: stored with period_year = FY start year.
    expect(standardDueDate('gstr9', 2024, 3, 'monthly')).toBe('2025-12-31');
  });

  it('bars filing after three years from the due date', () => {
    expect(timeBarredFrom('2022-11-20')).toBe('2025-11-20');
    expect(isTimeBarred('2022-11-20', '2025-11-20')).toBe(false);
    expect(isTimeBarred('2022-11-20', '2025-11-21')).toBe(true);
  });
});
