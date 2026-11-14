/**
 * The window of dates a return period covers.
 *
 * CMP-08 is quarterly on the financial year; GSTR-1 and 3B are monthly unless the shop is on
 * QRMP, in which case they are quarterly too; GSTR-9 is the whole financial year. Getting this
 * wrong files a correct set of figures against the wrong months, which is harder to spot than a
 * wrong figure.
 */
import type { Tx } from '../../db/tx.js';
import { compositionQuarter } from '../../domain/gst/composition.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';

/** Last day of a month, without constructing a date in the wrong timezone. */
export function lastDayOf(year: number, month: number): string {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const firstOfNext = new Date(Date.UTC(nextYear, nextMonth - 1, 1));
  const last = new Date(firstOfNext.getTime() - 86_400_000);
  return last.toISOString().slice(0, 10);
}

/** The month a financial year starting in `startMonth` ends in. */
export const fyEndMonth = (startMonth: number): number => (startMonth === 1 ? 12 : startMonth - 1);

/** The financial year that starts in `startYear`: its first and last day. */
export function fyWindow(startYear: number, startMonth: number): { from: string; to: string } {
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  return {
    from: `${startYear}-${String(startMonth).padStart(2, '0')}-01`,
    to: lastDayOf(endYear, fyEndMonth(startMonth)),
  };
}

/** The settings a window depends on. */
export interface WindowSettings {
  readonly fyStartMonth: number;
  readonly filingFrequency: string;
}

/** The window for a period, from settings already in hand (no database call). */
export function windowFromSettings(
  settings: WindowSettings,
  returnType: string,
  year: number,
  month: number,
): { from: string; to: string } {
  // For GSTR-9 the "year" is the year the financial year starts in; the month is ignored.
  if (returnType === 'gstr9') return fyWindow(year, settings.fyStartMonth);
  const quarterly = returnType === 'cmp08' || settings.filingFrequency === 'qrmp';
  if (!quarterly) {
    return { from: `${year}-${String(month).padStart(2, '0')}-01`, to: lastDayOf(year, month) };
  }
  const quarter = compositionQuarter(year, month, settings.fyStartMonth);
  return {
    from: `${quarter.fromYear}-${String(quarter.fromMonth).padStart(2, '0')}-01`,
    to: lastDayOf(quarter.toYear, quarter.toMonth),
  };
}

export async function periodWindow(
  tx: Tx,
  returnType: string,
  year: number,
  month: number,
): Promise<{ from: string; to: string }> {
  return windowFromSettings(await tenantsRepository.getSettings(tx), returnType, year, month);
}
