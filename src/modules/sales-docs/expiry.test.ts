import { describe, expect, it } from 'vitest';
import { effectiveStatus, isExpired, todayIn } from './expiry.js';

describe('offer expiry', () => {
  it('is expired only when open and strictly past the validity date', () => {
    expect(isExpired('open', '2026-10-29', '2026-10-30')).toBe(true);
    expect(isExpired('open', '2026-10-30', '2026-10-30')).toBe(false);
    expect(isExpired('open', '2026-10-31', '2026-10-30')).toBe(false);
  });

  it('never expires a document with no validity date', () => {
    expect(isExpired('open', null, '2026-10-30')).toBe(false);
    expect(isExpired('open', undefined, '2026-10-30')).toBe(false);
  });

  it('leaves a document that is no longer open as it is', () => {
    for (const status of ['converted', 'closed', 'cancelled']) {
      expect(isExpired(status, '2020-01-01', '2026-10-30')).toBe(false);
      expect(effectiveStatus(status, '2020-01-01', '2026-10-30')).toBe(status);
    }
  });

  it('shows expired in place of open', () => {
    expect(effectiveStatus('open', '2026-10-29', '2026-10-30')).toBe('expired');
    expect(effectiveStatus('open', '2026-10-30', '2026-10-30')).toBe('open');
  });

  it("reads today in the shop's time zone", () => {
    const at = (tz: string) => todayIn(tz);
    expect(at('Asia/Kolkata')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
