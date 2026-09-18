import { describe, expect, it } from 'vitest';
import {
  financialYearOf,
  formatDocumentNumber,
  isBlockExhausted,
  maxSequenceFor,
  mergeRanges,
  nextInBlock,
  remainingInBlock,
  unusedTails,
  validateSeriesFormat,
  type NumberBlock,
  type NumberingRules,
  type SeriesFormat,
} from './series.js';
import { ValidationError } from '../../lib/errors.js';

const INDIA_FY_START = 4;
const MAX_LENGTH = 16;
const RULES: NumberingRules = { maxLength: MAX_LENGTH, minSequenceHeadroom: 99_999 };
const FY = financialYearOf('2026-06-15', INDIA_FY_START);
const FORMAT: SeriesFormat = {
  prefix: 'INV',
  includeFinancialYear: true,
  padding: 5,
  separator: '/',
};

const format = (seq: number, f: SeriesFormat = FORMAT) =>
  formatDocumentNumber(f, FY, seq, MAX_LENGTH);

function block(overrides: Partial<NumberBlock> = {}): NumberBlock {
  return {
    startSeq: 101,
    endSeq: 150,
    consumedUpTo: null,
    expiresAt: new Date('2026-12-31T00:00:00Z'),
    ...overrides,
  };
}

describe('financial year', () => {
  it('runs April to March with display and in-number labels', () => {
    expect(FY).toEqual({
      startYear: 2026,
      label: '2026-27',
      shortLabel: '26-27',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
    });
  });

  it('switches exactly on the start month', () => {
    expect(financialYearOf('2026-03-31', INDIA_FY_START).label).toBe('2025-26');
    expect(financialYearOf('2026-04-01', INDIA_FY_START).label).toBe('2026-27');
  });

  it('handles leap years and calendar-year financial years', () => {
    expect(financialYearOf('2023-05-01', 3).endDate).toBe('2024-02-29');
    expect(financialYearOf('2024-05-01', 3).endDate).toBe('2025-02-28');
    expect(financialYearOf('2026-06-15', 1)).toMatchObject({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
  });

  it('accepts only a calendar date string', () => {
    expect(() => financialYearOf('2026-04-01T00:00:00Z', INDIA_FY_START)).toThrow(ValidationError);
  });
});

describe('document number formatting', () => {
  it('uses the short financial-year label', () => {
    expect(format(42)).toBe('INV/26-27/00042');
  });

  it('renders a per-counter series without the year', () => {
    const perCounter = {
      ...FORMAT,
      prefix: 'IN',
      outletCode: 'M1',
      counterCode: 'C1',
      includeFinancialYear: false,
      padding: 3,
    };
    expect(format(7, perCounter)).toBe('IN/M1/C1/007');
  });

  it('rejects a sequence that outgrows its padding past the limit', () => {
    expect(format(999_999)).toBe('INV/26-27/999999');
    expect(() => format(1_000_000)).toThrow(/exceeds 16/);
  });

  it('rejects illegal characters and non-positive sequences', () => {
    expect(() => format(1, { ...FORMAT, separator: '#' })).toThrow(/does not permit/);
    expect(() => format(0)).toThrow(ValidationError);
  });
});

describe('series format validation', () => {
  it('reports the real ceiling', () => {
    expect(maxSequenceFor(FORMAT, FY, MAX_LENGTH)).toBe(999_999);
  });

  it('accepts a format with headroom', () => {
    expect(() => validateSeriesFormat(FORMAT, FY, RULES)).not.toThrow();
    expect(() =>
      validateSeriesFormat(
        { ...FORMAT, counterCode: 'C1', includeFinancialYear: false },
        FY,
        RULES,
      ),
    ).not.toThrow();
  });

  it('rejects a format that would overflow mid-year', () => {
    expect(() => validateSeriesFormat({ ...FORMAT, counterCode: 'C1' }, FY, RULES)).toThrow(
      /only number up to/,
    );
  });

  it('rejects padding wider than the room available', () => {
    expect(() => validateSeriesFormat({ ...FORMAT, padding: 9 }, FY, RULES)).toThrow(
      /does not fit/,
    );
  });

  it('takes limits from the rules it is given', () => {
    expect(() =>
      validateSeriesFormat(FORMAT, FY, { maxLength: MAX_LENGTH, minSequenceHeadroom: 10_000_000 }),
    ).toThrow(/only number up to/);
  });
});

describe('number blocks', () => {
  const now = new Date('2026-06-15T10:00:00Z');

  it('tracks remaining capacity and the next number', () => {
    expect(remainingInBlock(block({ consumedUpTo: 120 }))).toBe(30);
    expect(nextInBlock(block(), now)).toBe(101);
    expect(nextInBlock(block({ consumedUpTo: 120 }), now)).toBe(121);
  });

  it('returns null rather than reusing a number when spent or expired', () => {
    expect(nextInBlock(block({ consumedUpTo: 150 }), now)).toBeNull();
    expect(isBlockExhausted(block({ expiresAt: new Date('2026-06-01T00:00:00Z') }), now)).toBe(
      true,
    );
  });

  it('never issues the same number from adjacent blocks', () => {
    const issued = new Set<number>();
    for (let current of [
      block({ startSeq: 1, endSeq: 50 }),
      block({ startSeq: 51, endSeq: 100 }),
    ]) {
      for (let next = nextInBlock(current, now); next !== null; next = nextInBlock(current, now)) {
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

  it('reports expired unused tails but not live blocks', () => {
    expect(
      unusedTails(
        [
          block({ consumedUpTo: 130, expiresAt: expired }),
          block({ startSeq: 151, endSeq: 200, consumedUpTo: null, expiresAt: expired }),
          block({ startSeq: 201, endSeq: 250, consumedUpTo: 210 }),
        ],
        now,
      ),
    ).toEqual([
      { from: 131, to: 150 },
      { from: 151, to: 200 },
    ]);
  });

  it('merges adjacent and overlapping ranges', () => {
    expect(
      mergeRanges([
        { from: 151, to: 200 },
        { from: 101, to: 150 },
        { from: 300, to: 310 },
      ]),
    ).toEqual([
      { from: 101, to: 200 },
      { from: 300, to: 310 },
    ]);
  });
});
