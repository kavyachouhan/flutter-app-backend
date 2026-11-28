import { describe, expect, it } from 'vitest';
import { cancellationDate, groupUnused, type UnusedNumber } from './unused.js';

const n = (seq: number, status: UnusedNumber['status'] = 'cancellable'): UnusedNumber => ({
  blockId: 'b',
  seq,
  status,
});

describe('groupUnused', () => {
  it('joins consecutive numbers into ranges, lowest first', () => {
    expect(groupUnused([n(124), n(121), n(122), n(123), n(130)])).toEqual([
      { from: 121, to: 124, count: 4, status: 'cancellable' },
      { from: 130, to: 130, count: 1, status: 'cancellable' },
    ]);
  });

  it('splits a run where the status changes', () => {
    expect(groupUnused([n(1), n(2), n(3, 'device_offline'), n(4, 'device_offline')])).toEqual([
      { from: 1, to: 2, count: 2, status: 'cancellable' },
      { from: 3, to: 4, count: 2, status: 'device_offline' },
    ]);
  });

  it('nothing unused, no ranges', () => {
    expect(groupUnused([])).toEqual([]);
  });
});

describe('cancellationDate', () => {
  const today = '2026-12-10';

  it('the last day the block was billed from, so the gap closes in that period', () => {
    expect(
      cancellationDate({
        lastDocumentDate: '2026-11-20',
        leasedOn: '2026-11-01',
        today,
        periodFiled: false,
      }),
    ).toBe('2026-11-20');
  });

  it('a block never billed from: the day it was leased', () => {
    expect(
      cancellationDate({
        lastDocumentDate: null,
        leasedOn: '2026-11-01',
        today,
        periodFiled: false,
      }),
    ).toBe('2026-11-01');
  });

  it('today when that period is already filed: a filed return is never changed', () => {
    expect(
      cancellationDate({
        lastDocumentDate: '2026-11-20',
        leasedOn: '2026-11-01',
        today,
        periodFiled: true,
      }),
    ).toBe(today);
  });

  it('never a day in the future', () => {
    expect(
      cancellationDate({
        lastDocumentDate: '2026-12-31',
        leasedOn: '2026-11-01',
        today,
        periodFiled: false,
      }),
    ).toBe(today);
  });
});
