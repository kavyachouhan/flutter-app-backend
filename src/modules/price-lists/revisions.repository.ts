import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export interface PriceRevisionRow {
  id: string;
  target: 'item_sale_price' | 'price_list';
  priceListId: string | null;
  categoryId: string | null;
  supplierId: string | null;
  operation:
    | 'percent_increase'
    | 'percent_decrease'
    | 'amount_increase'
    | 'amount_decrease'
    | 'set_from_cost';
  /** NUMERIC: a string from pg. */
  operationValue: string;
  roundToPaise: number | null;
  effectiveFrom: string | null;
  status:
    | 'pending'
    | 'analysing'
    | 'analysed'
    | 'applying'
    | 'applied'
    | 'failed'
    | 'cancelled';
  totalRows: number;
  analysedUpToRow: number;
  appliedUpToRow: number;
  changeCount: number;
  skipCount: number;
  errorCount: number;
  catalogueFingerprint: string | null;
  errorSummary: Record<string, unknown> | null;
  createdBy: string;
  analysedAt: Date | null;
  appliedAt: Date | null;
  lastProgressAt: Date | null;
  createdAt: Date;
}

export interface PriceRevisionRowRow {
  id: string;
  rowNo: number;
  itemId: string;
  itemName: string;
  minQuantity: number;
  action: 'pending' | 'change' | 'skip' | 'error';
  oldPrice: number | null;
  newPrice: number | null;
  reason: string | null;
  appliedAt: Date | null;
}

/** One item in the revision's scope, with everything needed to price it. */
export interface RevisionCandidate {
  itemId: string;
  minQuantity: number;
  currentPrice: number;
  averageCost: number | null;
}

const REVISION_COLUMNS = `
  id, target, price_list_id AS "priceListId", category_id AS "categoryId",
  supplier_id AS "supplierId", operation, operation_value AS "operationValue",
  round_to_paise AS "roundToPaise", effective_from AS "effectiveFrom", status,
  total_rows AS "totalRows", analysed_up_to_row AS "analysedUpToRow",
  applied_up_to_row AS "appliedUpToRow", change_count AS "changeCount",
  skip_count AS "skipCount", error_count AS "errorCount",
  catalogue_fingerprint AS "catalogueFingerprint", error_summary AS "errorSummary",
  created_by AS "createdBy", analysed_at AS "analysedAt", applied_at AS "appliedAt",
  last_progress_at AS "lastProgressAt", created_at AS "createdAt"`;

export const revisionsRepository = {
  /**
   * `FOR UPDATE` on the job row, which is what serialises the chunks: a double
   * tap or two open tabs cannot both claim the same slice. Same guard the
   * importer uses, and for the same reason.
   */
  find(tx: Tx, id: string, forUpdate = false): Promise<PriceRevisionRow | undefined> {
    return tx.one<PriceRevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM price_revisions WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
  },

  list(
    tx: Tx,
    status: string | undefined,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<PriceRevisionRow[]> {
    return tx.many<PriceRevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM price_revisions
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [status ?? null, cursor?.k ?? null, cursor?.id ?? null, limit + 1],
    );
  },

  async insert(
    tx: Tx,
    r: {
      id: string;
      target: string;
      priceListId: string | null;
      categoryId: string | null;
      supplierId: string | null;
      operation: string;
      operationValue: number;
      roundToPaise: number | null;
      effectiveFrom: string | null;
      createdBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO price_revisions (id, tenant_id, target, price_list_id, category_id, supplier_id,
         operation, operation_value, round_to_paise, effective_from, status, created_by,
         last_progress_at)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, now())`,
      [
        r.id,
        r.target,
        r.priceListId,
        r.categoryId,
        r.supplierId,
        r.operation,
        r.operationValue,
        r.roundToPaise,
        r.effectiveFrom,
        r.createdBy,
      ],
    );
  },

  async setStatus(tx: Tx, id: string, status: string): Promise<void> {
    await tx.query(
      'UPDATE price_revisions SET status = $2, last_progress_at = now() WHERE id = $1',
      [id, status],
    );
  },

  async fail(tx: Tx, id: string, errorSummary: Record<string, unknown>): Promise<void> {
    await tx.query(
      `UPDATE price_revisions SET status = 'failed', error_summary = $2::jsonb,
         last_progress_at = now() WHERE id = $1`,
      [id, JSON.stringify(errorSummary)],
    );
  },

  /**
   * Items in scope, as a stable 1-based list.
   *
   * Ordered by item id rather than name so the row numbering cannot shift
   * between analyse and apply if someone renames an item mid-revision — the
   * cursor is the row number, and a reordered set would re-apply one row and
   * skip another.
   *
   * For a list revision the candidates are the list's own rows, since those
   * are what gets rewritten. For a catalogue revision they are the items.
   */
  candidates(
    tx: Tx,
    revision: PriceRevisionRow,
    outletId: string | null,
    fromRowNo: number,
    limit: number,
  ): Promise<RevisionCandidate[]> {
    if (revision.target === 'price_list') {
      return tx.many<RevisionCandidate>(
        `SELECT pli.item_id AS "itemId", pli.min_quantity AS "minQuantity",
                pli.unit_price AS "currentPrice", ic.avg_cost AS "averageCost"
         FROM price_list_items pli
         JOIN items i ON i.id = pli.item_id AND i.deleted_at IS NULL
         LEFT JOIN item_costs ic ON ic.item_id = pli.item_id
           AND ($2::uuid IS NULL OR ic.outlet_id = $2::uuid)
         WHERE pli.price_list_id = $1 AND pli.deleted_at IS NULL
           AND ($3::uuid IS NULL OR i.category_id = $3::uuid)
         ORDER BY pli.item_id, pli.min_quantity
         OFFSET $4 LIMIT $5`,
        [revision.priceListId, outletId, revision.categoryId, fromRowNo, limit],
      );
    }
    return tx.many<RevisionCandidate>(
      `SELECT i.id AS "itemId", 0::bigint AS "minQuantity", i.sale_price AS "currentPrice",
              ic.avg_cost AS "averageCost"
       FROM items i
       LEFT JOIN item_costs ic ON ic.item_id = i.id
         AND ($1::uuid IS NULL OR ic.outlet_id = $1::uuid)
       WHERE i.deleted_at IS NULL AND i.is_active
         AND ($2::uuid IS NULL OR i.category_id = $2::uuid)
         AND ($3::uuid IS NULL OR EXISTS (
               SELECT 1 FROM purchase_bill_lines pbl
               JOIN purchase_bills pb ON pb.id = pbl.purchase_bill_id
               WHERE pbl.item_id = i.id AND pb.supplier_id = $3::uuid AND pb.status <> 'void'))
       ORDER BY i.id
       OFFSET $4 LIMIT $5`,
      [outletId, revision.categoryId, revision.supplierId, fromRowNo, limit],
    );
  },

  async countCandidates(
    tx: Tx,
    revision: PriceRevisionRow,
  ): Promise<number> {
    if (revision.target === 'price_list') {
      const row = await tx.one<{ count: string }>(
        `SELECT count(*) AS count FROM price_list_items pli
         JOIN items i ON i.id = pli.item_id AND i.deleted_at IS NULL
         WHERE pli.price_list_id = $1 AND pli.deleted_at IS NULL
           AND ($2::uuid IS NULL OR i.category_id = $2::uuid)`,
        [revision.priceListId, revision.categoryId],
      );
      return Number(row?.count ?? 0);
    }
    const row = await tx.one<{ count: string }>(
      `SELECT count(*) AS count FROM items i
       WHERE i.deleted_at IS NULL AND i.is_active
         AND ($1::uuid IS NULL OR i.category_id = $1::uuid)
         AND ($2::uuid IS NULL OR EXISTS (
               SELECT 1 FROM purchase_bill_lines pbl
               JOIN purchase_bills pb ON pb.id = pbl.purchase_bill_id
               WHERE pbl.item_id = i.id AND pb.supplier_id = $2::uuid AND pb.status <> 'void'))`,
      [revision.categoryId, revision.supplierId],
    );
    return Number(row?.count ?? 0);
  },

  async insertRows(
    tx: Tx,
    revisionId: string,
    rows: readonly {
      id: string;
      rowNo: number;
      itemId: string;
      minQuantity: number;
      action: string;
      oldPrice: number | null;
      newPrice: number | null;
      reason: string | null;
    }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO price_revision_rows (id, tenant_id, revision_id, row_no, item_id, min_quantity,
         action, old_price, new_price, reason)
       SELECT r.id, app.current_tenant_id(), $1, r."rowNo", r."itemId", r."minQuantity",
              r.action, r."oldPrice", r."newPrice", r.reason
       FROM jsonb_to_recordset($2::jsonb) AS r(
         id uuid, "rowNo" int, "itemId" uuid, "minQuantity" bigint, action text,
         "oldPrice" bigint, "newPrice" bigint, reason text)
       ON CONFLICT (tenant_id, revision_id, item_id, min_quantity) DO NOTHING`,
      [revisionId, JSON.stringify(rows)],
    );
  },

  /** Clears a previous analysis, but never a row already applied. */
  async resetAnalysis(tx: Tx, revisionId: string): Promise<void> {
    await tx.query(
      'DELETE FROM price_revision_rows WHERE revision_id = $1 AND applied_at IS NULL',
      [revisionId],
    );
    await tx.query(
      `UPDATE price_revisions SET analysed_up_to_row = applied_up_to_row, change_count = 0,
         skip_count = 0, error_count = 0 WHERE id = $1`,
      [revisionId],
    );
  },

  async recordProgress(
    tx: Tx,
    id: string,
    progress: {
      analysedUpToRow: number;
      totalRows: number;
      changeCount: number;
      skipCount: number;
      errorCount: number;
      fingerprint: string;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE price_revisions
       SET analysed_up_to_row = $2, total_rows = $3,
           change_count = change_count + $4, skip_count = skip_count + $5,
           error_count = error_count + $6, catalogue_fingerprint = $7,
           analysed_at = now(), last_progress_at = now()
       WHERE id = $1`,
      [
        id,
        progress.analysedUpToRow,
        progress.totalRows,
        progress.changeCount,
        progress.skipCount,
        progress.errorCount,
        progress.fingerprint,
      ],
    );
  },

  /** The next chunk of priced-and-previewed rows that have not been written. */
  pendingApply(
    tx: Tx,
    revisionId: string,
    limit: number,
  ): Promise<{ id: string; rowNo: number; itemId: string; minQuantity: number; newPrice: number }[]> {
    return tx.many(
      `SELECT id, row_no AS "rowNo", item_id AS "itemId", min_quantity AS "minQuantity",
              new_price AS "newPrice"
       FROM price_revision_rows
       WHERE revision_id = $1 AND applied_at IS NULL AND action = 'change'
       ORDER BY row_no
       LIMIT $2`,
      [revisionId, limit],
    );
  },

  async markRowsApplied(tx: Tx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.query(
      'UPDATE price_revision_rows SET applied_at = now() WHERE id = ANY($1::uuid[])',
      [[...ids]],
    );
  },

  async setAppliedCursor(tx: Tx, id: string, rowNo: number, finished: boolean): Promise<void> {
    await tx.query(
      `UPDATE price_revisions
       SET applied_up_to_row = GREATEST(applied_up_to_row, $2),
           status = CASE WHEN $3 THEN 'applied' ELSE 'applying' END,
           applied_at = CASE WHEN $3 THEN now() ELSE applied_at END,
           last_progress_at = now()
       WHERE id = $1`,
      [id, rowNo, finished],
    );
  },

  /** Writes the new catalogue prices for one chunk, in one statement. */
  async applyItemPrices(
    tx: Tx,
    rows: readonly { itemId: string; newPrice: number }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `UPDATE items SET sale_price = r."newPrice", updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS r("itemId" uuid, "newPrice" bigint)
       WHERE items.id = r."itemId"`,
      [JSON.stringify(rows)],
    );
  },

  async applyListPrices(
    tx: Tx,
    priceListId: string,
    rows: readonly { itemId: string; minQuantity: number; newPrice: number }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `UPDATE price_list_items SET unit_price = r."newPrice", updated_at = now()
       FROM jsonb_to_recordset($2::jsonb)
         AS r("itemId" uuid, "minQuantity" bigint, "newPrice" bigint)
       WHERE price_list_items.price_list_id = $1
         AND price_list_items.item_id = r."itemId"
         AND price_list_items.min_quantity = r."minQuantity"
         AND price_list_items.deleted_at IS NULL`,
      [priceListId, JSON.stringify(rows)],
    );
  },

  listRows(
    tx: Tx,
    revisionId: string,
    action: string | undefined,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<PriceRevisionRowRow[]> {
    return tx.many<PriceRevisionRowRow>(
      `SELECT r.id, r.row_no AS "rowNo", r.item_id AS "itemId", i.name AS "itemName",
              r.min_quantity AS "minQuantity", r.action, r.old_price AS "oldPrice",
              r.new_price AS "newPrice", r.reason, r.applied_at AS "appliedAt"
       FROM price_revision_rows r JOIN items i ON i.id = r.item_id
       WHERE r.revision_id = $1
         AND ($2::text IS NULL OR r.action = $2)
         AND ($3::int IS NULL OR r.row_no > $3::int)
       ORDER BY r.row_no
       LIMIT $4`,
      [revisionId, action ?? null, cursor?.k ?? null, limit + 1],
    );
  },

  /**
   * A cheap stamp of what the revision was previewed against.
   *
   * Count plus the latest update time: enough to notice items added, removed
   * or repriced since the preview, which is what makes a stale apply
   * detectable. The importer uses the same trick for the same reason.
   */
  async fingerprint(tx: Tx, revision: PriceRevisionRow): Promise<string> {
    if (revision.target === 'price_list') {
      const row = await tx.one<{ stamp: string }>(
        `SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '-') AS stamp
         FROM price_list_items WHERE price_list_id = $1 AND deleted_at IS NULL`,
        [revision.priceListId],
      );
      return row?.stamp ?? '0:-';
    }
    const row = await tx.one<{ stamp: string }>(
      `SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '-') AS stamp
       FROM items WHERE deleted_at IS NULL`,
    );
    return row?.stamp ?? '0:-';
  },
};
