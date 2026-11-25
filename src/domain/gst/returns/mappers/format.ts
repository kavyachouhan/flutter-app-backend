/**
 * GSTN wire formatting. Everything the portal formats differently from the neutral model lives
 * here, and is used only by mappers.
 */
import type { ReturnPeriod } from '../model.js';

/** Integer paise to a rupee number with at most two decimals, without float drift. */
export function rupees(paise: number): number {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`Amount must be whole paise, got ${paise}`);
  }
  const sign = paise < 0 ? -1 : 1;
  const abs = Math.abs(paise);
  // Build the decimal from integer parts so 0.07 stays 0.07 rather than 0.07000000000000001.
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return sign * Number(`${whole}.${String(frac).padStart(2, '0')}`);
}

/** `2026-11-05` -> `05-11-2026` (the format of every GSTR-1 date field). */
export function gstnDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new TypeError(`Not an ISO date: ${iso}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/** `{2026, 11}` -> `112026` (MMYYYY). */
export function gstnPeriod(period: ReturnPeriod): string {
  if (period.month < 1 || period.month > 12) throw new RangeError(`Bad month ${period.month}`);
  return `${String(period.month).padStart(2, '0')}${period.year}`;
}

/** Rate as the portal's number, free of float noise (0.25 stays 0.25). */
export function rate(percent: number): number {
  return Number(percent.toFixed(2));
}
