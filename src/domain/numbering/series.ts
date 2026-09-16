/**
 * Document numbering: financial years, series formats and leased number blocks.
 *
 * A device must issue legally numbered invoices with no network, so it cannot
 * ask the server per invoice. While online it leases a contiguous block; blocks
 * never overlap (enforced by an exclusion constraint), so offline issuance on
 * many devices cannot collide. Unused numbers in an expired block are reported
 * as gaps for GSTR-1 Table 13, never reissued.
 */
import { ValidationError } from '../../lib/errors.js';

export interface FinancialYear {
  readonly startYear: number;
  /** "2026-27", for display. */
  readonly label: string;
  /**
   * "26-27", used inside document numbers. The two characters it saves matter
   * against the GST length limit: "INV/2026-27/" leaves far fewer digits for
   * the sequence than "INV/26-27/".
   */
  readonly shortLabel: string;
  readonly startDate: string;
  readonly endDate: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function financialYearStarting(startYear: number, fyStartMonth: number): FinancialYear {
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12) {
    throw new ValidationError('Financial year start month must be 1-12.');
  }
  const crossesYear = fyStartMonth !== 1;
  const endYear = crossesYear ? startYear + 1 : startYear;
  const endMonth = crossesYear ? fyStartMonth - 1 : 12;
  // Day 0 of the following month is the last day of this one, leap years included.
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  const labelEnd = String(startYear + 1).slice(-2);

  return {
    startYear,
    label: `${startYear}-${labelEnd}`,
    shortLabel: `${String(startYear).slice(-2)}-${labelEnd}`,
    startDate: `${startYear}-${pad2(fyStartMonth)}-01`,
    endDate: `${endYear}-${pad2(endMonth)}-${pad2(lastDay)}`,
  };
}

/**
 * Takes a calendar date string, never a Date: a Date resolves in the server's
 * timezone and can move an invoice dated on the first day of the year into the
 * previous financial year.
 */
export function financialYearOf(date: string, fyStartMonth: number): FinancialYear {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match)
    throw new ValidationError('A document date must be YYYY-MM-DD.', { details: { date } });
  const year = Number(match[1]);
  const month = Number(match[2]);
  return financialYearStarting(month >= fyStartMonth ? year : year - 1, fyStartMonth);
}

export interface SeriesFormat {
  readonly prefix: string;
  readonly outletCode?: string;
  readonly counterCode?: string;
  readonly includeFinancialYear: boolean;
  readonly padding: number;
  readonly separator: string;
}

export interface NumberingRules {
  /** GST rule 46(b) limit. */
  readonly maxLength: number;
  /** Smallest sequence ceiling a format may have. */
  readonly minSequenceHeadroom: number;
}

// GST rule 46(b) permits only these characters in a document number.
const DOCUMENT_NUMBER_CHARACTERS = /^[A-Za-z0-9/-]+$/;

function fixedSegments(format: SeriesFormat, fy: FinancialYear): string[] {
  const segments = [format.prefix];
  if (format.outletCode) segments.push(format.outletCode);
  if (format.counterCode) segments.push(format.counterCode);
  if (format.includeFinancialYear) segments.push(fy.shortLabel);
  return segments;
}

export function formatDocumentNumber(
  format: SeriesFormat,
  fy: FinancialYear,
  sequenceNo: number,
  maxLength: number,
): string {
  if (!Number.isSafeInteger(sequenceNo) || sequenceNo < 1) {
    throw new ValidationError('A document sequence number must be a positive integer.');
  }
  const number = [
    ...fixedSegments(format, fy),
    String(sequenceNo).padStart(format.padding, '0'),
  ].join(format.separator);
  if (number.length > maxLength) {
    throw new ValidationError(`Document number "${number}" exceeds ${maxLength} characters.`, {
      details: { number, maxLength },
    });
  }
  if (!DOCUMENT_NUMBER_CHARACTERS.test(number)) {
    throw new ValidationError(
      `Document number "${number}" contains characters GST does not permit.`,
    );
  }
  return number;
}

/**
 * The highest sequence this format can print within `maxLength`. Padding does
 * not bound it: padStart only pads up to the width, so a sequence wider than the
 * padding lengthens the number — a format can work on invoice 1 and overflow
 * months later.
 */
export function maxSequenceFor(format: SeriesFormat, fy: FinancialYear, maxLength: number): number {
  const fixedLength = [...fixedSegments(format, fy), ''].join(format.separator).length;
  const digits = maxLength - fixedLength;
  if (digits < 1) return 0;
  return Math.min(10 ** digits - 1, Number.MAX_SAFE_INTEGER);
}

export function validateSeriesFormat(
  format: SeriesFormat,
  fy: FinancialYear,
  rules: NumberingRules,
): void {
  if (!/^[A-Za-z0-9-]+$/.test(format.prefix)) {
    throw new ValidationError('A series prefix may contain only letters, digits and hyphens.');
  }
  if (!Number.isInteger(format.padding) || format.padding < 1) {
    throw new ValidationError('Sequence padding must be a positive integer.');
  }

  // Checked before rendering a sample so an oversized format gets the actionable message.
  const ceiling = maxSequenceFor(format, fy, rules.maxLength);
  if (ceiling < rules.minSequenceHeadroom) {
    throw new ValidationError(
      `This format can only number up to ${ceiling} documents within ${rules.maxLength} characters. ` +
        'Shorten the prefix or codes, or drop the financial-year segment (the invoice date already implies it).',
      { details: { maxSequence: ceiling, required: rules.minSequenceHeadroom } },
    );
  }
  if (10 ** format.padding - 1 > ceiling) {
    throw new ValidationError(
      `Padding of ${format.padding} does not fit; there is room for ${String(ceiling).length} digits.`,
    );
  }

  formatDocumentNumber(format, fy, 1, rules.maxLength);
}

export interface NumberBlock {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly consumedUpTo: number | null;
  readonly expiresAt: Date;
}

export function remainingInBlock(block: NumberBlock): number {
  return block.endSeq - (block.consumedUpTo ?? block.startSeq - 1);
}

export function isBlockExhausted(block: NumberBlock, now: Date): boolean {
  return remainingInBlock(block) <= 0 || block.expiresAt <= now;
}

/** null means lease a new block; wrapping around would reissue a number. */
export function nextInBlock(block: NumberBlock, now: Date): number | null {
  return isBlockExhausted(block, now) ? null : (block.consumedUpTo ?? block.startSeq - 1) + 1;
}

export interface SequenceRange {
  from: number;
  to: number;
}

/** A live block's unused tail is not a gap: the device may still use it offline. */
export function unusedTails(blocks: readonly NumberBlock[], now: Date): SequenceRange[] {
  return blocks
    .filter((b) => b.expiresAt <= now && (b.consumedUpTo ?? b.startSeq - 1) < b.endSeq)
    .map((b) => ({ from: (b.consumedUpTo ?? b.startSeq - 1) + 1, to: b.endSeq }))
    .sort((a, b) => a.from - b.from);
}

export function mergeRanges(ranges: readonly SequenceRange[]): SequenceRange[] {
  const merged: SequenceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}
