/**
 * Validity of an offer (estimate, proforma invoice).
 *
 * "Expired" is never stored: a document is expired when it is still open and its `validUntil`
 * is before the shop's today, so nothing has to run at midnight to flip it. The last day of
 * validity is still valid.
 */

/** Today's date, YYYY-MM-DD, in the shop's time zone. */
export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

export function isExpired(
  status: string,
  validUntil: string | null | undefined,
  today: string,
): boolean {
  return status === 'open' && !!validUntil && validUntil < today;
}

/** The status a client should show: `expired` stands in for an open document past its validity. */
export function effectiveStatus(
  status: string,
  validUntil: string | null | undefined,
  today: string,
): string {
  return isExpired(status, validUntil, today) ? 'expired' : status;
}
