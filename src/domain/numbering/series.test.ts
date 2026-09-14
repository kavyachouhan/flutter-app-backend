/**
 * Document numbering tests.
 *
 * This is the wedge feature, so the tests are written to pin the properties a
 * merchant is being promised: no duplicates, explainable gaps, a correct
 * financial-year reset, and numbers GST will actually accept.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERIES_FORMAT,
  financialYearOf,
  formatDocumentNumber,
  gapsFromBlocks,
  maxSequenceFor,
  isBlockExhausted,
  mergeGaps,
  nextInBlock,
  remainingInBlock,
  validateSeriesFormat,
  type NumberBlock,
  type SeriesFormat,
} from './series.js';
import { ValidationError } from '../../lib/errors.js';

const FY_2026 = financialYearOf('2026-06-15');

function block(overrides: Partial<NumberBlock> = {}): NumberBlock {
  return {
    seriesId: 's1',
    deviceId: 'd1',
    startSeq: 101,
    endSeq: 150,
    consumedUpTo: null,
    expiresAt: new Date('2026-12-31T00:00:00Z'),
    ...overrides,
  };
}

describe('financial year', () => {
  it('runs April to March for India', () => {
    const fy = financialYearOf('2026-06-15');
    expect(fy.startYear).toBe(2026);
    expect(fy.label).toBe('2026-27');
    expect(fy.shortLabel).toBe('26-27');
    expect(fy.startDate).toBe('2026-04-01');
    expect(fy.endDate).toBe('2027-03-31');
  });

  it('puts January to March in the previous financial year', () => {
    const fy = financialYearOf('2027-02-10');
    expect(fy.startYear).toBe(2026);
    expect(fy.label).toBe('2026-27');
  });

  it('switches on 1 April exactly', () => {
    // The boundary that decides which year an invoice is filed in.
    expect(financialYearOf('2026-03-31').label).toBe('2025-26');
    expect(financialYearOf('2026-04-01').label).toBe('2026-27');
  });

  it('handles a leap year end date', () => {
    // FY ending February, so the last day depends on the leap year.
    const fy = financialYearOf('2024-05-01', 3);
    expect(fy.startDate).toBe('2024-03-01');
    expect(fy.endDate).toBe('2025-02-28');

    const leap = financialYearOf('2023-05-01', 3);
    expect(leap.endDate).toBe('2024-02-29');
  });

  it('supports a calendar-year financial year', () => {
    const fy = financialYearOf('2026-06-15', 1);
    expect(fy.startDate).toBe('2026-01-01');
    expect(fy.endDate).toBe('2026-12-31');
  });

  it('takes a date string, never a Date object', () => {
    // A Date would be resolved in the server's timezone, so an invoice dated
    // 1 April IST on a UTC server would land in the previous financial year.
    expect(() => financialYearOf('2026-04-01T00:00:00Z')).toThrow(ValidationError);
    expect(() => financialYearOf('01/04/2026')).toThrow(ValidationError);
  });
});

describe('document number formatting', () => {
  it('builds the standard number', () => {
    // The short financial-year form is what goes in the number; the long
    // form is for display only.
    expect(formatDocumentNumber(DEFAULT_SERIES_FORMAT, FY_2026, 42)).toBe('INV/26-27/00042');
  });

  it('includes outlet and counter codes when configured', () => {
    // A multi-outlet, multi-counter series drops the financial year: all four
    // segments plus a usable sequence cannot fit in 16 characters, and the
    // year is already implied by the invoice date.
    const format: SeriesFormat = {
      ...DEFAULT_SERIES_FORMAT,
      prefix: 'IN',
      outletCode: 'M1',
      counterCode: 'C1',
      includeFinancialYear: false,
      padding: 3,
    };
    expect(formatDocumentNumber(format, FY_2026, 7)).toBe('IN/M1/C1/007');
  });

  it('omits the financial year when configured off', () => {
    const format: SeriesFormat = { ...DEFAULT_SERIES_FORMAT, includeFinancialYear: false };
    expect(formatDocumentNumber(format, FY_2026, 42)).toBe('INV/00042');
  });

  it('rejects a number longer than GST rule 46(b) allows', () => {
    const format: SeriesFormat = {
      ...DEFAULT_SERIES_FORMAT,
      prefix: 'INVOICE',
      outletCode: 'MUMBAI',
      counterCode: 'COUNTER',
    };
    expect(() => formatDocumentNumber(format, FY_2026, 1)).toThrow(/at most 16/);
  });

  it('rejects a sequence that outgrows its padding and breaches the limit', () => {
    // padStart only pads up to the width, so a sequence wider than `padding`
    // makes the number longer. This is the real mid-year overflow, and the
    // reason validateSeriesFormat checks the ceiling rather than a sample.
    expect(formatDocumentNumber(DEFAULT_SERIES_FORMAT, FY_2026, 999_999)).toBe('INV/26-27/999999');
    expect(() => formatDocumentNumber(DEFAULT_SERIES_FORMAT, FY_2026, 1_000_000)).toThrow(
      /at most 16/,
    );
  });

  it('rejects characters GST does not permit', () => {
    const format: SeriesFormat = { ...DEFAULT_SERIES_FORMAT, separator: '#' };
    expect(() => formatDocumentNumber(format, FY_2026, 1)).toThrow(/does not permit/);
  });

  it('rejects a non-positive sequence number', () => {
    expect(() => formatDocumentNumber(DEFAULT_SERIES_FORMAT, FY_2026, 0)).toThrow(ValidationError);
    expect(() => formatDocumentNumber(DEFAULT_SERIES_FORMAT, FY_2026, -1)).toThrow(ValidationError);
  });
});

describe('series format validation', () => {
  it('accepts the default format', () => {
    expect(() => validateSeriesFormat(DEFAULT_SERIES_FORMAT, FY_2026)).not.toThrow();
  });

  it('reports the true ceiling, which padding does not bound', () => {
    // "INV/26-27/" is 10 characters, leaving 6 digits.
    expect(maxSequenceFor(DEFAULT_SERIES_FORMAT, FY_2026)).toBe(999_999);

    // Dropping the financial year frees six more characters.
    expect(maxSequenceFor({ ...DEFAULT_SERIES_FORMAT, includeFinancialYear: false }, FY_2026)).toBe(
      999_999_999_999,
    );
  });

  it('rejects a format that would overflow mid-year', () => {
    // The failure this catches: a format renders fine on invoice 1 and
    // produces a 17-character number later in the year, with the year's
    // filings already depending on the series.
    const tight: SeriesFormat = {
      ...DEFAULT_SERIES_FORMAT,
      prefix: 'INVOICE',
      outletCode: 'MAIN',
    };
    expect(() => validateSeriesFormat(tight, FY_2026)).toThrow(/only number up to/);
  });

  it('rejects a per-counter series that still carries the financial year', () => {
    // "INV/C1/26-27/" leaves only 3 digits. Against a hard 16-character limit
    // a multi-counter shop has to give something up, and the year is the
    // right thing to drop — it is already implied by the invoice date.
    expect(() =>
      validateSeriesFormat({ ...DEFAULT_SERIES_FORMAT, counterCode: 'C1' }, FY_2026),
    ).toThrow(/only number up to/);
  });

  it('accepts the realistic per-counter format', () => {
    const perCounter: SeriesFormat = {
      ...DEFAULT_SERIES_FORMAT,
      counterCode: 'C1',
      includeFinancialYear: false,
    };
    expect(() => validateSeriesFormat(perCounter, FY_2026)).not.toThrow();
    expect(formatDocumentNumber(perCounter, FY_2026, 42)).toBe('INV/C1/00042');
  });

  it('rejects padding wider than the room available', () => {
    expect(() => validateSeriesFormat({ ...DEFAULT_SERIES_FORMAT, padding: 9 }, FY_2026)).toThrow(
      /does not fit/,
    );
  });

  it('rejects a prefix with illegal characters', () => {
    expect(() =>
      validateSeriesFormat({ ...DEFAULT_SERIES_FORMAT, prefix: 'IN V' }, FY_2026),
    ).toThrow(ValidationError);
  });

  it('rejects an out-of-range padding', () => {
    expect(() => validateSeriesFormat({ ...DEFAULT_SERIES_FORMAT, padding: 0 }, FY_2026)).toThrow(
      ValidationError,
    );
  });
});

describe('number blocks', () => {
  const now = new Date('2026-06-15T10:00:00Z');

  it('reports its size and remaining capacity', () => {
    expect(remainingInBlock(block())).toBe(50);
    expect(remainingInBlock(block({ consumedUpTo: 120 }))).toBe(30);
    expect(remainingInBlock(block({ consumedUpTo: 150 }))).toBe(0);
  });

  it('hands out the first number of an untouched block', () => {
    expect(nextInBlock(block(), now)).toBe(101);
  });

  it('continues from where the device left off', () => {
    expect(nextInBlock(block({ consumedUpTo: 120 }), now)).toBe(121);
  });

  it('returns null rather than reusing a number when spent', () => {
    // Wrapping around and reissuing is the exact failure this design exists
    // to prevent — the client must lease a new block instead.
    expect(nextInBlock(block({ consumedUpTo: 150 }), now)).toBeNull();
  });

  it('returns null once the lease has expired', () => {
    const expired = block({ expiresAt: new Date('2026-06-01T00:00:00Z') });
    expect(nextInBlock(expired, now)).toBeNull();
    expect(isBlockExhausted(expired, now)).toBe(true);
  });

  it('never issues the same number from two blocks', () => {
    // Two devices, adjacent blocks. Exhausting both must yield 100 distinct
    // numbers — this is the property the whole feature is sold on.
    const a = block({ deviceId: 'd1', startSeq: 1, endSeq: 50 });
    const b = block({ deviceId: 'd2', startSeq: 51, endSeq: 100 });

    const issued = new Set<number>();
    for (const start of [a, b]) {
      let current = start;
      for (;;) {
        const next = nextInBlock(current, now);
        if (next === null) break;
        expect(issued.has(next)).toBe(false);
        issued.add(next);
        current = { ...current, consumedUpTo: next };
      }
    }

    expect(issued.size).toBe(100);
  });
});

describe('gap reporting', () => {
  const now = new Date('2026-06-15T10:00:00Z');
  const expired = new Date('2026-06-01T00:00:00Z');
  const live = new Date('2026-12-31T00:00:00Z');

  it('reports the unused tail of an expired block', () => {
    const gaps = gapsFromBlocks(
      [block({ startSeq: 101, endSeq: 150, consumedUpTo: 130, expiresAt: expired })],
      now,
    );
    expect(gaps).toEqual([{ from: 131, to: 150 }]);
  });

  it('reports a wholly unused expired block', () => {
    const gaps = gapsFromBlocks(
      [block({ startSeq: 101, endSeq: 150, consumedUpTo: null, expiresAt: expired })],
      now,
    );
    expect(gaps).toEqual([{ from: 101, to: 150 }]);
  });

  it('does not report a live block as a gap', () => {
    // The device may still be working through it offline.
    const gaps = gapsFromBlocks(
      [block({ startSeq: 101, endSeq: 150, consumedUpTo: 130, expiresAt: live })],
      now,
    );
    expect(gaps).toEqual([]);
  });

  it('reports nothing for a fully consumed block', () => {
    const gaps = gapsFromBlocks(
      [block({ startSeq: 101, endSeq: 150, consumedUpTo: 150, expiresAt: expired })],
      now,
    );
    expect(gaps).toEqual([]);
  });

  it('merges adjacent gaps into one range', () => {
    expect(
      mergeGaps([
        { from: 101, to: 150 },
        { from: 151, to: 200 },
      ]),
    ).toEqual([{ from: 101, to: 200 }]);
  });

  it('merges overlapping gaps', () => {
    expect(
      mergeGaps([
        { from: 101, to: 160 },
        { from: 150, to: 200 },
      ]),
    ).toEqual([{ from: 101, to: 200 }]);
  });

  it('keeps genuinely separate gaps apart', () => {
    expect(
      mergeGaps([
        { from: 101, to: 150 },
        { from: 200, to: 210 },
      ]),
    ).toEqual([
      { from: 101, to: 150 },
      { from: 200, to: 210 },
    ]);
  });

  it('handles an empty gap list', () => {
    expect(mergeGaps([])).toEqual([]);
  });
});
