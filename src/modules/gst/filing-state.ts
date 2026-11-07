import type { Tx } from '../../db/tx.js';

/**
 * Whether the GSTR-1 covering a document has been filed. Once it has, the document is on the
 * government's record: it cannot be cancelled, only corrected by a note or an amendment (D27).
 */
export async function gstr1FiledFor(tx: Tx, gstin: string | null, documentDate: string): Promise<boolean> {
  if (!gstin) return false;
  const row = await tx.one<{ filed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM gst_return_periods
        WHERE gstin = $1 AND return_type = 'gstr1' AND status = 'filed'
          AND period_from <= $2::date AND period_to >= $2::date) AS filed`,
    [gstin, documentDate],
  );
  return row?.filed ?? false;
}
