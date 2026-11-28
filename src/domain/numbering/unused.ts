/**
 * Reserved numbers nobody used, and when they may be declared cancelled.
 *
 * A device reserves a block of numbers while online so it can bill offline.
 * Numbers it never used cannot be reissued (two bills must never share a
 * number), so GSTR-1 Table 13 needs them accounted for: declared cancelled.
 *
 * Declaring one too early is the real danger: a till billing offline may
 * already have printed that number on a customer's bill that has not reached
 * the server yet. So a number is only cancellable once nothing can still be
 * issued under it:
 *
 *   device removed          the device was deactivated; it can never sync again.
 *   block expired, device   the device stops issuing from a block when it
 *   in contact since        expires, and has been online after that (with a
 *                           grace for its outbox to drain), so anything it
 *                           issued has had its chance to arrive.
 *   block long expired      ABANDONED_AFTER_DAYS past expiry with no contact:
 *                           a lost phone the owner never removed.
 *
 * Everything else waits: a live block is still being billed from, and an
 * expired one whose device has been silent since may hold unsent bills.
 */

export type UnusedStatus = 'cancellable' | 'in_use' | 'device_offline';

/** Time after a block's expiry for a device that came online to send its outbox. */
export const CONTACT_GRACE_HOURS = 1;
/** After this many days past expiry with no contact, a block is treated as abandoned. */
export const ABANDONED_AFTER_DAYS = 30;

export interface UnusedNumber {
  readonly blockId: string;
  readonly seq: number;
  readonly status: UnusedStatus;
}

export interface UnusedRange {
  readonly from: number;
  readonly to: number;
  readonly count: number;
  readonly status: UnusedStatus;
}

/** Consecutive numbers with the same status, as ranges, lowest first. */
export function groupUnused(numbers: readonly UnusedNumber[]): UnusedRange[] {
  const sorted = [...numbers].sort((a, b) => a.seq - b.seq);
  const out: { from: number; to: number; status: UnusedStatus }[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last.status === n.status && n.seq === last.to + 1) last.to = n.seq;
    else out.push({ from: n.seq, to: n.seq, status: n.status });
  }
  return out.map((r) => ({ ...r, count: r.to - r.from + 1 }));
}

/**
 * The day a block's unused numbers are reported as cancelled (which GSTR-1
 * period lists them): the last day the block was billed from, so the numbers
 * close the gap in the same period as their neighbours; or the day it was
 * leased, if it was never used. Today when that period's GSTR-1 is already
 * filed (a filed return is never changed) or the day is somehow in the future.
 * Dates are YYYY-MM-DD in the business's calendar.
 */
export function cancellationDate(input: {
  readonly lastDocumentDate: string | null;
  readonly leasedOn: string;
  readonly today: string;
  readonly periodFiled: boolean;
}): string {
  const base = input.lastDocumentDate ?? input.leasedOn;
  if (input.periodFiled || base > input.today) return input.today;
  return base;
}
