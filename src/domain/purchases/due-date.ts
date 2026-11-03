/**
 * When a purchase bill falls due.
 *
 * Pure, and mirrored by the Dart port (`khata_domain`), because a phone records a bill offline and
 * the due date it shows must be the one the server will store. Supplier payment terms decide it
 * unless the bill states a due date of its own; a supplier with no terms has none.
 *
 * Calendar arithmetic is done in UTC on a date string (never a local time), so the answer cannot
 * move with the server's or the phone's time zone.
 */
export function dueDateFor(documentDate: string, termsDays: number | null): string | null {
  if (termsDays === null) return null;
  const date = new Date(`${documentDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + termsDays);
  return date.toISOString().slice(0, 10);
}
