/**
 * Inputs for the numbering contract vectors: financial years, document
 * number formatting, format validation and the offline block arithmetic a
 * device runs when it issues an invoice without the server.
 */
import type { NumberingRules, SeriesFormat } from '../../src/domain/numbering/series.js';

/** A block as it travels in JSON: dates as ISO strings, never Date objects. */
export interface BlockInput {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly consumedUpTo: number | null;
  readonly expiresAt: string;
}

export interface FyRef {
  readonly date: string;
  readonly fyStartMonth: number;
}

export type NumberingContractCase =
  | { name: string; op: 'financialYearOf'; input: FyRef }
  | {
      name: string;
      op: 'formatDocumentNumber';
      input: { format: SeriesFormat; fy: FyRef; sequenceNo: number; maxLength: number };
    }
  | {
      name: string;
      op: 'maxSequenceFor';
      input: { format: SeriesFormat; fy: FyRef; maxLength: number };
    }
  | {
      name: string;
      op: 'validateSeriesFormat';
      input: { format: SeriesFormat; fy: FyRef; rules: NumberingRules };
    }
  | { name: string; op: 'remainingInBlock'; input: { block: BlockInput } }
  | { name: string; op: 'isBlockExhausted'; input: { block: BlockInput; now: string } }
  | { name: string; op: 'nextInBlock'; input: { block: BlockInput; now: string } }
  | { name: string; op: 'unusedTails'; input: { blocks: BlockInput[]; now: string } }
  | { name: string; op: 'mergeRanges'; input: { ranges: { from: number; to: number }[] } };

const FY_JUNE = { date: '2026-06-15', fyStartMonth: 4 } as const;
const RULES: NumberingRules = { maxLength: 16, minSequenceHeadroom: 99_999 };
const FORMAT: SeriesFormat = {
  prefix: 'INV',
  includeFinancialYear: true,
  padding: 5,
  separator: '/',
};
const PER_COUNTER: SeriesFormat = {
  prefix: 'IN',
  outletCode: 'M1',
  counterCode: 'C1',
  includeFinancialYear: false,
  padding: 3,
  separator: '/',
};

const NOW = '2026-06-15T10:00:00.000Z';
const EXPIRED = '2026-06-01T00:00:00.000Z';
const LIVE = '2026-12-31T00:00:00.000Z';

function block(overrides: Partial<BlockInput> = {}): BlockInput {
  return { startSeq: 101, endSeq: 150, consumedUpTo: null, expiresAt: LIVE, ...overrides };
}

export function numberingCases(): NumberingContractCase[] {
  return [
    // Financial years
    { name: 'April-start FY in June', op: 'financialYearOf', input: FY_JUNE },
    {
      name: 'last day before FY start',
      op: 'financialYearOf',
      input: { date: '2026-03-31', fyStartMonth: 4 },
    },
    {
      name: 'first day of FY',
      op: 'financialYearOf',
      input: { date: '2026-04-01', fyStartMonth: 4 },
    },
    {
      name: 'March-start FY with leap year end',
      op: 'financialYearOf',
      input: { date: '2023-05-01', fyStartMonth: 3 },
    },
    {
      name: 'March-start FY with non-leap end',
      op: 'financialYearOf',
      input: { date: '2024-05-01', fyStartMonth: 3 },
    },
    {
      name: 'calendar-year FY',
      op: 'financialYearOf',
      input: { date: '2026-06-15', fyStartMonth: 1 },
    },
    {
      name: 'December-start FY',
      op: 'financialYearOf',
      input: { date: '2026-11-30', fyStartMonth: 12 },
    },
    {
      name: 'century short label',
      op: 'financialYearOf',
      input: { date: '2099-06-15', fyStartMonth: 4 },
    },
    {
      name: 'timestamp is not a calendar date',
      op: 'financialYearOf',
      input: { date: '2026-04-01T00:00:00Z', fyStartMonth: 4 },
    },
    {
      name: 'month 13 is rejected',
      op: 'financialYearOf',
      input: { date: '2026-04-01', fyStartMonth: 13 },
    },

    // Formatting
    {
      name: 'short FY label in the number',
      op: 'formatDocumentNumber',
      input: { format: FORMAT, fy: FY_JUNE, sequenceNo: 42, maxLength: 16 },
    },
    {
      name: 'per-counter series without the year',
      op: 'formatDocumentNumber',
      input: { format: PER_COUNTER, fy: FY_JUNE, sequenceNo: 7, maxLength: 16 },
    },
    {
      name: 'sequence wider than padding',
      op: 'formatDocumentNumber',
      input: { format: FORMAT, fy: FY_JUNE, sequenceNo: 999_999, maxLength: 16 },
    },
    {
      name: 'sequence overflowing the limit',
      op: 'formatDocumentNumber',
      input: { format: FORMAT, fy: FY_JUNE, sequenceNo: 1_000_000, maxLength: 16 },
    },
    {
      name: 'illegal separator',
      op: 'formatDocumentNumber',
      input: { format: { ...FORMAT, separator: '#' }, fy: FY_JUNE, sequenceNo: 1, maxLength: 16 },
    },
    {
      name: 'zero sequence',
      op: 'formatDocumentNumber',
      input: { format: FORMAT, fy: FY_JUNE, sequenceNo: 0, maxLength: 16 },
    },
    {
      name: 'hyphen separator with outlet code',
      op: 'formatDocumentNumber',
      input: {
        format: { ...FORMAT, outletCode: 'PUNE', separator: '-' },
        fy: FY_JUNE,
        sequenceNo: 15,
        maxLength: 16,
      },
    },

    // Ceilings and validation
    {
      name: 'ceiling of the default format',
      op: 'maxSequenceFor',
      input: { format: FORMAT, fy: FY_JUNE, maxLength: 16 },
    },
    {
      name: 'ceiling of a per-counter format',
      op: 'maxSequenceFor',
      input: { format: PER_COUNTER, fy: FY_JUNE, maxLength: 16 },
    },
    {
      name: 'ceiling with no room',
      op: 'maxSequenceFor',
      input: { format: { ...FORMAT, prefix: 'INVOICE-LONG' }, fy: FY_JUNE, maxLength: 16 },
    },
    {
      name: 'valid format',
      op: 'validateSeriesFormat',
      input: { format: FORMAT, fy: FY_JUNE, rules: RULES },
    },
    {
      name: 'valid per-counter format',
      op: 'validateSeriesFormat',
      input: {
        format: { ...FORMAT, counterCode: 'C1', includeFinancialYear: false },
        fy: FY_JUNE,
        rules: RULES,
      },
    },
    {
      name: 'format overflowing mid-year',
      op: 'validateSeriesFormat',
      input: { format: { ...FORMAT, counterCode: 'C1' }, fy: FY_JUNE, rules: RULES },
    },
    {
      name: 'padding wider than the room',
      op: 'validateSeriesFormat',
      input: { format: { ...FORMAT, padding: 9 }, fy: FY_JUNE, rules: RULES },
    },
    {
      name: 'prefix with illegal characters',
      op: 'validateSeriesFormat',
      input: { format: { ...FORMAT, prefix: 'IN V' }, fy: FY_JUNE, rules: RULES },
    },
    {
      name: 'zero padding',
      op: 'validateSeriesFormat',
      input: { format: { ...FORMAT, padding: 0 }, fy: FY_JUNE, rules: RULES },
    },
    {
      name: 'stricter headroom rule',
      op: 'validateSeriesFormat',
      input: {
        format: FORMAT,
        fy: FY_JUNE,
        rules: { maxLength: 16, minSequenceHeadroom: 10_000_000 },
      },
    },

    // Blocks
    { name: 'remaining in a fresh block', op: 'remainingInBlock', input: { block: block() } },
    {
      name: 'remaining after consumption',
      op: 'remainingInBlock',
      input: { block: block({ consumedUpTo: 120 }) },
    },
    {
      name: 'remaining when spent',
      op: 'remainingInBlock',
      input: { block: block({ consumedUpTo: 150 }) },
    },
    { name: 'next in a fresh block', op: 'nextInBlock', input: { block: block(), now: NOW } },
    {
      name: 'next after consumption',
      op: 'nextInBlock',
      input: { block: block({ consumedUpTo: 120 }), now: NOW },
    },
    {
      name: 'next when spent',
      op: 'nextInBlock',
      input: { block: block({ consumedUpTo: 150 }), now: NOW },
    },
    {
      name: 'next when expired',
      op: 'nextInBlock',
      input: { block: block({ expiresAt: EXPIRED }), now: NOW },
    },
    {
      name: 'next at the exact expiry instant',
      op: 'nextInBlock',
      input: { block: block({ expiresAt: NOW }), now: NOW },
    },
    {
      name: 'exhausted when expired',
      op: 'isBlockExhausted',
      input: { block: block({ expiresAt: EXPIRED }), now: NOW },
    },
    {
      name: 'not exhausted while live',
      op: 'isBlockExhausted',
      input: { block: block({ consumedUpTo: 149 }), now: NOW },
    },

    // Gaps
    {
      name: 'expired tails reported, live block ignored',
      op: 'unusedTails',
      input: {
        blocks: [
          block({ consumedUpTo: 130, expiresAt: EXPIRED }),
          block({ startSeq: 151, endSeq: 200, consumedUpTo: null, expiresAt: EXPIRED }),
          block({ startSeq: 201, endSeq: 250, consumedUpTo: 210 }),
        ],
        now: NOW,
      },
    },
    {
      name: 'fully consumed expired block has no tail',
      op: 'unusedTails',
      input: { blocks: [block({ consumedUpTo: 150, expiresAt: EXPIRED })], now: NOW },
    },
    {
      name: 'tails are sorted by start',
      op: 'unusedTails',
      input: {
        blocks: [
          block({ startSeq: 301, endSeq: 350, expiresAt: EXPIRED }),
          block({ consumedUpTo: 140, expiresAt: EXPIRED }),
        ],
        now: NOW,
      },
    },
    {
      name: 'merge adjacent and overlapping ranges',
      op: 'mergeRanges',
      input: {
        ranges: [
          { from: 151, to: 200 },
          { from: 101, to: 150 },
          { from: 300, to: 310 },
        ],
      },
    },
    {
      name: 'merge contained range',
      op: 'mergeRanges',
      input: {
        ranges: [
          { from: 1, to: 100 },
          { from: 10, to: 20 },
        ],
      },
    },
    { name: 'merge empty', op: 'mergeRanges', input: { ranges: [] } },
  ];
}
