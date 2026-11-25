/**
 * Runs the account purge inside the API, daily at ACCOUNT_PURGE_DAILY_AT
 * (Indian time; default 02:00, when hardly anyone is billing — the purge
 * briefly blocks writes to the tables it empties). `off` disables it.
 *
 * Safe with any number of API instances: they may all start a run, but each
 * business is purged once (the purge function locks its deletion request and
 * the second caller finds it done).
 *
 * Catch-up: an instance asleep or restarting at the scheduled time misses
 * that run. So shortly after start-up it also purges anything whose promised
 * date is within CATCH_UP_DAYS — the Privacy Policy's 30 days hold even if
 * the scheduled time is missed for days on end.
 */
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { purgeDueDeletions, type PurgeOptions, type PurgeOutcome } from './purge.js';

const log = createLogger('account-purge');

/** India has one time zone and no daylight saving: UTC+05:30, all year. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** The catch-up run purges whatever is promised within this many days. */
export const CATCH_UP_DAYS = 3;
/** Start-up is busy enough; the catch-up waits this long after it. */
const CATCH_UP_DELAY_MS = 60_000;

/** Milliseconds from [now] to the next [at] ("HH:MM", Indian time). Never 0. */
export function msUntilNext(now: Date, at: string): number {
  const [hours, minutes] = at.split(':').map(Number) as [number, number];
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  let next =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hours, minutes) -
    IST_OFFSET_MS;
  if (next <= now.getTime()) next += DAY_MS;
  return next - now.getTime();
}

export interface PurgeSchedule {
  stop(): void;
}

/** Starts the daily purge (and the start-up catch-up). Returns how to stop it. */
export function startAccountPurgeSchedule(
  run: (options: PurgeOptions) => Promise<PurgeOutcome[]> = purgeDueDeletions,
  at: string = env.ACCOUNT_PURGE_DAILY_AT ?? '02:00',
): PurgeSchedule {
  if (at === 'off') {
    log.info('Account purge schedule is off (ACCOUNT_PURGE_DAILY_AT=off)');
    return { stop: () => undefined };
  }

  let running = false;
  let daily: NodeJS.Timeout | undefined;

  const purge = async (label: string, options: PurgeOptions) => {
    // A run still going (thousands of rows) is not doubled up.
    if (running) return;
    running = true;
    try {
      const outcomes = await run(options);
      report(label, outcomes);
    } catch (error) {
      // The database or storage is unreachable. The next run tries again.
      log.error({ err: error }, `Account purge (${label}) could not run`);
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    const wait = msUntilNext(new Date(), at);
    daily = setTimeout(() => {
      void purge('daily', {}).finally(scheduleNext);
    }, wait);
    // The schedule never keeps the process alive on its own.
    daily.unref();
  };

  const catchUp = setTimeout(() => {
    void purge('catch-up', { dueBy: new Date(Date.now() + CATCH_UP_DAYS * DAY_MS) });
  }, CATCH_UP_DELAY_MS);
  catchUp.unref();

  scheduleNext();
  log.info({ at, timeZone: 'Asia/Kolkata' }, 'Account purge scheduled daily');

  return {
    stop: () => {
      clearTimeout(catchUp);
      if (daily) clearTimeout(daily);
    },
  };
}

function report(label: string, outcomes: PurgeOutcome[]): void {
  if (outcomes.length === 0) {
    log.info(`Account purge (${label}): nothing due`);
    return;
  }
  for (const o of outcomes) {
    if (o.status === 'failed') {
      log.error(
        { tenantId: o.tenantId, error: o.error },
        `Account purge (${label}) failed for a business; retried next run`,
      );
    } else {
      log.info(
        {
          tenantId: o.tenantId,
          status: o.status,
          rows: o.rowsDeleted,
          users: o.usersDeleted,
          files: o.filesDeleted,
        },
        `Account purge (${label})`,
      );
    }
  }
}
