/**
 * Document numbering — the headline wedge.
 *
 * The pitch is "your invoice numbers will never duplicate", and competing
 * products demonstrably fail at this: merchants report delayed GST filings
 * because their app issued the same invoice number twice. Getting it right is
 * the reason per-counter series and leased blocks exist in the schema from
 * commit one.
 *
 * Four properties have to hold simultaneously, and it is the combination that
 * makes this hard:
 *
 *   Unique      — no number is ever issued twice, even with two cashiers
 *                 billing at the same instant on the same counter.
 *   Gapless     — GST expects a continuous series. Gaps must be explainable,
 *                 and reported in GSTR-1 Table 13 rather than hidden.
 *   Offline     — a device with no network must still issue a legally
 *                 numbered invoice. It cannot ask the server at bill time.
 *   FY-scoped   — the series resets each financial year (1 April in India).
 *
 * "Offline" is what rules out the obvious designs. A database sequence needs
 * the network. A client-side counter cannot know what other devices have used.
 * The answer is leasing: while online, a device reserves a contiguous BLOCK of
 * numbers and consumes them locally. Two devices never hold overlapping
 * blocks, so offline issuance cannot collide.
 *
 * This module is pure — formatting, financial-year arithmetic and block
 * arithmetic. Allocation itself needs a row lock and lives in the repository.
 */

import { ValidationError } from '../../lib/errors.js';

/** The document types that carry their own number series. */
export type DocumentType =
  | 'invoice'
  | 'credit_note'
  | 'debit_note'
  | 'purchase'
  | 'payment'
  | 'estimate'
  | 'delivery_challan';

export interface FinancialYear {
  /** Calendar year the FY starts in: 2026 for FY 2026-27. */
  readonly startYear: number;
  /** `2026-27`, for display on reports and the invoice header. */
  readonly label: string;
  /**
   * `26-27`, for use inside the document number.
   *
   * Two characters shorter than `label`, which matters a great deal against
   * the 16-character GST limit: `INV/2026-27/` leaves room for only 4 digits
   * (9,999 documents), while `INV/26-27/` leaves 6 (999,999). A shop billing
   * 40 times a day exhausts the former inside one financial year.
   */
  readonly shortLabel: string;
  /** Inclusive start date, `YYYY-MM-DD`. */
  readonly startDate: string;
  /** Inclusive end date, `YYYY-MM-DD`. */
  readonly endDate: string;
}

/**
 * The financial year a date falls in.
 *
 * `fyStartMonth` is 4 for India (April–March) but is stored per tenant rather
 * than assumed, because it is what document numbering resets on and a future
 * market would differ.
 *
 * `date` is a calendar date string, never a Date object. A Date would be
 * interpreted in the server's timezone, so an invoice dated 2026-04-01 IST on
 * a UTC server would fall back to 2026-03-31 and be numbered into the previous
 * financial year — a GSTR-1 mismatch that is painful to unpick.
 */
export function financialYearOf(date: string, fyStartMonth = 4): FinancialYear {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new ValidationError('A document date must be in YYYY-MM-DD form.', {
      details: { date },
    });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) {
    throw new ValidationError('Invalid month in the document date.', { details: { date } });
  }

  const startYear = month >= fyStartMonth ? year : year - 1;
  const endYear = startYear + 1;

  const pad = (n: number) => String(n).padStart(2, '0');
  const endMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1;
  const endMonthYear = fyStartMonth === 1 ? startYear : endYear;

  return {
    startYear,
    label: `${startYear}-${String(endYear).slice(-2)}`,
    shortLabel: `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`,
    startDate: `${startYear}-${pad(fyStartMonth)}-01`,
    endDate: `${endMonthYear}-${pad(endMonth)}-${pad(lastDayOfMonth(endMonthYear, endMonth))}`,
  };
}

function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one, and this handles
  // leap years without a special case.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

export interface SeriesFormat {
  /** Business prefix, e.g. `INV`. */
  readonly prefix: string;
  /** Outlet code, included when a tenant has more than one outlet. */
  readonly outletCode?: string;
  /** Counter code. This is what makes concurrent tills non-colliding. */
  readonly counterCode?: string;
  /** Include the `2026-27` financial year segment. */
  readonly includeFinancialYear: boolean;
  /** Zero-padding width for the sequence number. */
  readonly padding: number;
  readonly separator: string;
}

export const DEFAULT_SERIES_FORMAT: SeriesFormat = {
  prefix: 'INV',
  includeFinancialYear: true,
  padding: 5,
  separator: '/',
};

/**
 * Builds the printed document number, e.g. `INV/MAIN/C1/2026-27/0042`.
 *
 * GST rule 46(b) constrains this: a document number may be at most 16
 * characters, and may contain only letters, digits, hyphen and slash. Exceeding
 * either is rejected at e-invoice/IRN generation and at GSTR-1 upload, so the
 * check happens here — at configuration time, where it is a fixable error —
 * rather than at filing time, where it is a crisis.
 */
export function formatDocumentNumber(
  format: SeriesFormat,
  financialYear: FinancialYear,
  sequenceNo: number,
): string {
  if (!Number.isSafeInteger(sequenceNo) || sequenceNo < 1) {
    throw new ValidationError('A document sequence number must be a positive integer.', {
      details: { sequenceNo },
    });
  }

  const segments = [format.prefix];
  if (format.outletCode) segments.push(format.outletCode);
  if (format.counterCode) segments.push(format.counterCode);
  if (format.includeFinancialYear) segments.push(financialYear.shortLabel);
  segments.push(String(sequenceNo).padStart(format.padding, '0'));

  const number = segments.join(format.separator);

  if (number.length > 16) {
    throw new ValidationError(
      `The generated document number "${number}" is ${number.length} characters. GST rule 46(b) ` +
        `allows at most 16. Shorten the prefix, outlet or counter code, or drop the financial ` +
        `year segment.`,
      { details: { number, length: number.length } },
    );
  }

  if (!/^[A-Za-z0-9/-]+$/.test(number)) {
    throw new ValidationError(
      `The generated document number "${number}" contains characters GST does not permit. ` +
        `Only letters, digits, hyphen and slash are allowed.`,
      { details: { number } },
    );
  }

  return number;
}

/** GST rule 46(b): a document number may be at most 16 characters. */
export const MAX_DOCUMENT_NUMBER_LENGTH = 16;

/**
 * The minimum headroom a series must have before it is allowed to be saved.
 *
 * A shop billing 40 times a day issues ~12,000 documents a year, so a format
 * that tops out at 9,999 would fail in February with the year's filings
 * already depending on it. 99,999 covers a very busy single counter with
 * room to spare.
 */
export const MIN_SEQUENCE_HEADROOM = 99_999;

/**
 * The highest sequence number this format can print without breaching the
 * 16-character limit.
 *
 * Note that `padding` does NOT bound this: padStart only pads *up* to the
 * width, so sequence 10000 under `padding: 4` renders as five digits and the
 * number grows by one character. That is the real failure mode — the format
 * looks fine on invoice 1 and breaks on invoice 10,000, mid-year.
 */
export function maxSequenceFor(format: SeriesFormat, financialYear: FinancialYear): number {
  const fixedLength = [
    format.prefix,
    ...(format.outletCode ? [format.outletCode] : []),
    ...(format.counterCode ? [format.counterCode] : []),
    ...(format.includeFinancialYear ? [financialYear.shortLabel] : []),
    '', // the sequence segment, measured separately
  ].join(format.separator).length;

  const digitsAvailable = MAX_DOCUMENT_NUMBER_LENGTH - fixedLength;
  if (digitsAvailable < 1) return 0;

  return 10 ** digitsAvailable - 1;
}

/**
 * Validates a format before it is saved.
 *
 * Checks the ceiling, not just a sample number: `INVOIC/2026-27/0001` renders
 * fine and the same format dies at sequence 10,000. Catching that at
 * configuration time is a one-line fix; catching it mid-year is not.
 */
export function validateSeriesFormat(format: SeriesFormat, sampleFy: FinancialYear): void {
  if (!/^[A-Za-z0-9-]{1,8}$/.test(format.prefix)) {
    throw new ValidationError('A series prefix must be 1-8 letters, digits or hyphens.', {
      details: { prefix: format.prefix },
    });
  }

  if (format.padding < 1 || format.padding > 10) {
    throw new ValidationError('Sequence padding must be between 1 and 10.', {
      details: { padding: format.padding },
    });
  }

  // Headroom is checked BEFORE rendering a sample, so a format that is too
  // long gets the actionable "it only reaches N documents" message rather
  // than a bare "this string is 18 characters".
  const ceiling = maxSequenceFor(format, sampleFy);
  if (ceiling < MIN_SEQUENCE_HEADROOM) {
    throw new ValidationError(
      `This format can only number up to ${ceiling.toLocaleString('en-IN')} documents before ` +
        `exceeding the ${MAX_DOCUMENT_NUMBER_LENGTH}-character limit GST allows, which a busy ` +
        `counter could reach inside one financial year. Shorten the prefix, outlet or counter ` +
        `code, or drop the financial year segment — the year is already implied by the ` +
        `invoice date.`,
      { details: { maxSequence: ceiling, required: MIN_SEQUENCE_HEADROOM } },
    );
  }

  // Padding wider than the space available would breach the limit on the very
  // first document.
  if (10 ** format.padding - 1 > ceiling) {
    throw new ValidationError(
      `Padding to ${format.padding} digits does not fit: this format has room for ` +
        `${String(ceiling).length} digits.`,
      { details: { padding: format.padding, maxSequence: ceiling } },
    );
  }

  // Finally, catch an illegal separator or prefix charset.
  formatDocumentNumber(format, sampleFy, 1);
}

// ---------------------------------------------------------------------------
// Number blocks
// ---------------------------------------------------------------------------

/**
 * A contiguous range of sequence numbers reserved for one device.
 *
 * Inclusive at both ends. A device holding [101, 150] may issue exactly those
 * 50 numbers with no network, and no other device can be holding any of them.
 */
export interface NumberBlock {
  readonly seriesId: string;
  readonly deviceId: string;
  readonly startSeq: number;
  readonly endSeq: number;
  /** Highest number the device has actually used, or null if none yet. */
  readonly consumedUpTo: number | null;
  /** Unused numbers past this point are reported as gaps, not reissued. */
  readonly expiresAt: Date;
}

/**
 * Default block size.
 *
 * The trade-off is between round-trips and gaps. Too small and a busy counter
 * asks for a new block mid-rush, exactly when the network is least reliable.
 * Too large and an abandoned block leaves a big hole in the series that has to
 * be explained in GSTR-1 Table 13. Fifty covers a typical shop's day with one
 * lease.
 */
export const DEFAULT_BLOCK_SIZE = 50;

/** Lease lifetime. A device that has not synced in a week has lost its block. */
export const DEFAULT_BLOCK_TTL_DAYS = 7;

export function blockSize(block: NumberBlock): number {
  return block.endSeq - block.startSeq + 1;
}

export function remainingInBlock(block: NumberBlock): number {
  const consumed = block.consumedUpTo ?? block.startSeq - 1;
  return block.endSeq - consumed;
}

export function isBlockExhausted(block: NumberBlock, now: Date): boolean {
  return remainingInBlock(block) <= 0 || block.expiresAt <= now;
}

/**
 * The next number a device should use from its block.
 *
 * Returns null when the block is spent or expired, which is the signal for the
 * client to lease another. Deliberately NOT "wrap around and reuse": reissuing
 * a number is the exact failure this whole design exists to prevent.
 */
export function nextInBlock(block: NumberBlock, now: Date): number | null {
  if (isBlockExhausted(block, now)) return null;
  return (block.consumedUpTo ?? block.startSeq - 1) + 1;
}

/**
 * Numbers reserved but never used, as closed ranges.
 *
 * These are the gaps GSTR-1 Table 13 asks a business to declare — "documents
 * issued" versus "cancelled/unused". Reporting them honestly is the difference
 * between a clean filing and a notice, which is why an abandoned block is
 * surfaced rather than quietly recycled.
 */
export function gapsFromBlocks(
  blocks: readonly NumberBlock[],
  now: Date,
): { from: number; to: number }[] {
  const gaps: { from: number; to: number }[] = [];

  for (const block of blocks) {
    // A live block's unused tail is not a gap yet — the device may still be
    // working through it offline.
    if (block.expiresAt > now) continue;

    const consumed = block.consumedUpTo ?? block.startSeq - 1;
    if (consumed < block.endSeq) {
      gaps.push({ from: consumed + 1, to: block.endSeq });
    }
  }

  return gaps.sort((a, b) => a.from - b.from);
}

/**
 * Merges adjacent and overlapping gap ranges.
 *
 * Two expired blocks [101,150] and [151,200] are one gap of 101-200 on the
 * return, not two. Filing them separately is not wrong, but it is noise, and
 * the merged form is what a human reconciling a series expects to see.
 */
export function mergeGaps(
  gaps: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
  if (gaps.length === 0) return [];

  const sorted = [...gaps].sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];

  for (const gap of sorted) {
    const last = merged[merged.length - 1];
    if (last && gap.from <= last.to + 1) {
      last.to = Math.max(last.to, gap.to);
    } else {
      merged.push({ ...gap });
    }
  }

  return merged;
}
