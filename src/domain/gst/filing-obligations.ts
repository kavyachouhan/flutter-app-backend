/**
 * Statutory facts about whether a return must be filed and whether it still can be. These
 * checks only produce warnings: they never block preparing a return. A shop may file an
 * optional return, and the portal is the final word on a time-barred one.
 *
 * Sources (all in `docs/gst/`):
 *   - Annual return (s.44) exemption up to ₹2 crore aggregate turnover:
 *       FY 2022-23: Notification 32/2023-CT
 *       FY 2023-24: Notification 14/2024-CT
 *       FY 2024-25 onwards: Notification 15/2025-CT
 *     Earlier years had their own notifications, which are not in the repo. Those years are
 *     past the three-year bar anyway.
 *   - Three-year bar: s.37(5) (GSTR-1), s.39(11) (GSTR-3B), s.44(2) (annual return), inserted by
 *     Finance Act 2023 ss.142-144 and in force from 01.10.2023 (Notification 28/2023-CT). A
 *     return cannot be filed after three years from its due date.
 *   - Due dates: GSTR-1 on the 11th of the next month (monthly) or the 13th after the quarter
 *     (QRMP), under s.37(1) and Rule 59. GSTR-3B on the 20th (monthly) or the 22nd/24th after the
 *     quarter by State group (QRMP), under Rule 61. Annual return on 31 December after the FY
 *     (Rule 80). Extensions by notification are not applied. For the time-bar warning the latest
 *     standard date is used (24th for QRMP 3B), so the warning never fires early.
 */

/** Paise. */
export const ANNUAL_RETURN_EXEMPTION_LIMIT_PAISE = 20_000_000_000;

/** First FY (start year) covered by a ₹2 crore exemption notification in the repo. */
const FIRST_EXEMPTION_FY = 2022;

export type AnnualReturnObligation =
  | { readonly status: 'optional'; readonly basis: string }
  | { readonly status: 'required'; readonly basis: string }
  | { readonly status: 'unknown'; readonly basis: string };

const exemptionNotification = (fyStartYear: number): string =>
  fyStartYear === 2022 ? '32/2023-CT' : fyStartYear === 2023 ? '14/2024-CT' : '15/2025-CT';

/**
 * Whether the GSTR-9 for a financial year is required, given the PAN's aggregate turnover for
 * that year (null when not known).
 */
export function annualReturnObligation(
  fyStartYear: number,
  aggregateTurnoverPaise: number | null,
): AnnualReturnObligation {
  if (fyStartYear < FIRST_EXEMPTION_FY) {
    return { status: 'unknown', basis: 'No exemption notification for this year is on file.' };
  }
  const notification = exemptionNotification(fyStartYear);
  if (aggregateTurnoverPaise === null) {
    return {
      status: 'unknown',
      basis: `Optional up to ₹2 crore aggregate turnover (Notification ${notification}); this year's aggregate turnover is not recorded.`,
    };
  }
  return aggregateTurnoverPaise <= ANNUAL_RETURN_EXEMPTION_LIMIT_PAISE
    ? { status: 'optional', basis: `Aggregate turnover is within ₹2 crore (Notification ${notification}).` }
    : { status: 'required', basis: `Aggregate turnover is above ₹2 crore (Notification ${notification}).` };
}

export type ReturnKind = 'gstr1' | 'gstr3b' | 'gstr9' | 'gstr1a' | 'cmp08' | 'gstr4';
export type FilingFrequency = 'monthly' | 'qrmp';

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The standard (unextended) due date of a return. `periodMonth` is the period's last month
 * (for a QRMP quarter, its third month; for GSTR-9, March of the FY, with `periodYear` the
 * FY's start year, as stored on `gst_return_periods`).
 */
export function standardDueDate(
  kind: ReturnKind,
  periodYear: number,
  periodMonth: number,
  frequency: FilingFrequency,
): string {
  if (kind === 'gstr9') return iso(periodYear + 1, 12, 31);
  // GSTR-4 by 30 June after the year (Rule 62 proviso, 12/2024-CT); CMP-08 by the 18th after the
  // quarter (Rule 62(1)(i)).
  if (kind === 'gstr4') return iso(periodYear + 1, 6, 30);
  if (kind === 'cmp08') {
    const y = periodMonth === 12 ? periodYear + 1 : periodYear;
    const m = periodMonth === 12 ? 1 : periodMonth + 1;
    return iso(y, m, 18);
  }
  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear;
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1;
  if (kind === 'gstr1') return iso(nextYear, nextMonth, frequency === 'qrmp' ? 13 : 11);
  return iso(nextYear, nextMonth, frequency === 'qrmp' ? 24 : 20);
}

/** The first day a return can no longer be filed (three years after its due date). */
export function timeBarredFrom(dueDate: string): string {
  const y = Number(dueDate.slice(0, 4)) + 3;
  return `${y}${dueDate.slice(4)}`;
}

/** True when `today` is past the three-year bar for a return due on `dueDate`. */
export function isTimeBarred(dueDate: string, today: string): boolean {
  return today.slice(0, 10) > timeBarredFrom(dueDate);
}
