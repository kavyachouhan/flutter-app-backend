import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATCH_UP_DAYS, msUntilNext, startAccountPurgeSchedule } from './purge-scheduler.js';
import type { PurgeOptions, PurgeOutcome } from './purge.js';

const HOUR = 60 * 60_000;

describe('msUntilNext (Indian time)', () => {
  it('02:00 IST is 20:30 UTC the evening before', () => {
    // 20:00 UTC = 01:30 IST: half an hour to go.
    expect(msUntilNext(new Date('2026-11-25T20:00:00Z'), '02:00')).toBe(HOUR / 2);
  });

  it('just after the time, waits for tomorrow', () => {
    // 20:31 UTC = 02:01 IST.
    expect(msUntilNext(new Date('2026-11-25T20:31:00Z'), '02:00')).toBe(24 * HOUR - 60_000);
  });

  it('exactly at the time, waits a full day rather than firing twice', () => {
    expect(msUntilNext(new Date('2026-11-25T20:30:00Z'), '02:00')).toBe(24 * HOUR);
  });

  it('in the Indian afternoon, the next 02:00 is that night', () => {
    // 09:30 UTC = 15:00 IST → 02:00 IST is 11 hours away.
    expect(msUntilNext(new Date('2026-11-25T09:30:00Z'), '02:00')).toBe(11 * HOUR);
  });

  it('crosses a month end', () => {
    // 2026-11-30 21:00 UTC = 2026-12-01 02:30 IST → next is 2026-12-02 02:00 IST.
    expect(msUntilNext(new Date('2026-11-30T21:00:00Z'), '02:00')).toBe(23.5 * HOUR);
  });
});

describe('startAccountPurgeSchedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T09:30:00Z')); // 15:00 IST
  });
  afterEach(() => vi.useRealTimers());

  const recorder = () => {
    const calls: PurgeOptions[] = [];
    const run = vi.fn((options: PurgeOptions): Promise<PurgeOutcome[]> => {
      calls.push(options);
      return Promise.resolve([]);
    });
    return { calls, run };
  };

  it('catches up shortly after start-up, for anything promised within a few days', async () => {
    const { calls, run } = recorder();
    const schedule = startAccountPurgeSchedule(run, '02:00');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.dueBy?.getTime()).toBe(Date.now() + CATCH_UP_DAYS * 24 * HOUR);
    schedule.stop();
  });

  it('then purges everything due at 02:00 IST, every day', async () => {
    const { calls, run } = recorder();
    const schedule = startAccountPurgeSchedule(run, '02:00');
    await vi.advanceTimersByTimeAsync(11 * HOUR); // to 02:00 IST
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({});
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(calls).toHaveLength(3);
    schedule.stop();
  });

  it('never runs a second purge while one is still going', async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<PurgeOutcome[]>((resolve) => {
          finish = () => resolve([]);
        }),
    );
    const schedule = startAccountPurgeSchedule(run, '15:02'); // 2 minutes after start
    await vi.advanceTimersByTimeAsync(60_000); // catch-up starts, and hangs
    await vi.advanceTimersByTimeAsync(60_000); // daily time arrives
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    schedule.stop();
  });

  it('keeps going after a run that throws', async () => {
    const run = vi.fn(() => Promise.reject(new Error('database unreachable')));
    const schedule = startAccountPurgeSchedule(run, '02:00');
    await vi.advanceTimersByTimeAsync(11 * HOUR + 24 * HOUR);
    expect(run).toHaveBeenCalledTimes(3); // catch-up, tonight, tomorrow night
    schedule.stop();
  });

  it('"off" schedules nothing', async () => {
    const { run } = recorder();
    startAccountPurgeSchedule(run, 'off');
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(run).not.toHaveBeenCalled();
  });

  it('stop() cancels what is scheduled', async () => {
    const { run } = recorder();
    startAccountPurgeSchedule(run, '02:00').stop();
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(run).not.toHaveBeenCalled();
  });
});
