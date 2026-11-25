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

/**
 * Whether the input tax credit recorded for a purchase document has been reported in a filed
 * GSTR-3B: the register row's period (by GSTIN and date) has a filed 3B, or the registration's
 * GSTR-3B lock (migration 0050) covers the date. Once it has, cancelling the document would
 * silently change a filed return; the correction is a debit note or a reversal in a later
 * return instead.
 */
export async function gstr3bFiledForItc(
  tx: Tx,
  sourceType: 'purchase_bill' | 'debit_note',
  sourceId: string,
): Promise<boolean> {
  const row = await tx.one<{ filed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM itc_register i
        WHERE i.source_type = $1 AND i.source_id = $2 AND i.gstin <> ''
          AND (EXISTS (SELECT 1 FROM gst_return_periods p
                        WHERE p.gstin = i.gstin AND p.return_type = 'gstr3b' AND p.status = 'filed'
                          AND p.period_from <= i.document_date AND p.period_to >= i.document_date)
               OR EXISTS (SELECT 1 FROM gst_registrations r
                           WHERE r.gstin = i.gstin AND r.deleted_at IS NULL
                             AND r.gstr3b_locked_through >= i.document_date))) AS filed`,
    [sourceType, sourceId],
  );
  return row?.filed ?? false;
}
