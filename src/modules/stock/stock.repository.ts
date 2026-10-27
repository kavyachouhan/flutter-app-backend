import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export type StockEntryType =
  | 'opening'
  | 'sale'
  | 'sale_void'
  | 'adjustment'
  | 'sale_return'
  | 'sale_return_void'
  | 'purchase'
  | 'purchase_void'
  | 'purchase_return'
  | 'purchase_return_void'
  | 'transfer_out'
  | 'transfer_in'
  | 'transfer_void'
  | 'count';

export interface NewStockEntry {
  /** null lets the database generate one (for entries derived from another document). */
  id: string | null;
  outletId: string;
  itemId: string;
  entryType: StockEntryType;
  quantityDelta: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: string;
  note: string | null;
  createdBy: string;
}

export interface StockEntryRow {
  id: string;
  outletId: string;
  itemId: string;
  entryType: StockEntryType;
  quantityDelta: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: Date;
  note: string | null;
  createdBy: string | null;
}

export interface BalanceRow {
  itemId: string;
  itemName: string;
  unit: string;
  /** Physical stock on the shelf, from the ledger. */
  quantity: number;
  /** Promised to open sales orders. Stays on the shelf until the invoice takes it out. */
  reserved: number;
  /** What a new sale may take: quantity less reserved. Never below the figure shown as on hand. */
  available: number;
  reorderLevel: number | null;
  updatedAt: Date;
}

const ENTRY_COLUMNS = `
  id, outlet_id AS "outletId", item_id AS "itemId", entry_type AS "entryType", quantity_delta AS "quantityDelta",
  reason_code AS "reasonCode", reference_type AS "referenceType", reference_id AS "referenceId",
  occurred_at AS "occurredAt", note, created_by AS "createdBy"`;

export const stockRepository = {
  async insertEntries(tx: Tx, entries: readonly NewStockEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await tx.query(
      `INSERT INTO stock_ledger_entries (id, tenant_id, outlet_id, item_id, entry_type, quantity_delta, reason_code,
         reference_type, reference_id, occurred_at, note, created_by)
       SELECT COALESCE(e.id, gen_random_uuid()), app.current_tenant_id(), e."outletId", e."itemId", e."entryType",
              e."quantityDelta", e."reasonCode", e."referenceType", e."referenceId", e."occurredAt", e.note, e."createdBy"
       FROM jsonb_to_recordset($1::jsonb) AS e(
         id uuid, "outletId" uuid, "itemId" uuid, "entryType" text, "quantityDelta" bigint, "reasonCode" text,
         "referenceType" text, "referenceId" uuid, "occurredAt" timestamptz, note text, "createdBy" uuid)`,
      [JSON.stringify(entries)],
    );
  },

  /**
   * Writes the negating entry for every ledger row a document produced. The
   * NOT EXISTS guard makes a second call a no-op, so a replayed void can never
   * double-restore stock.
   */
  async reverseEntries(
    tx: Tx,
    input: {
      referenceType: string;
      referenceId: string;
      entryType: StockEntryType;
      reversalType: StockEntryType;
      userId: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO stock_ledger_entries (id, tenant_id, outlet_id, item_id, entry_type, quantity_delta,
         reference_type, reference_id, occurred_at, created_by)
       SELECT gen_random_uuid(), tenant_id, outlet_id, item_id, $4, -quantity_delta, reference_type, reference_id, now(), $5
       FROM stock_ledger_entries s
       WHERE s.reference_type = $1 AND s.reference_id = $2 AND s.entry_type = $3
         AND NOT EXISTS (SELECT 1 FROM stock_ledger_entries r
                         WHERE r.reference_type = $1 AND r.reference_id = $2 AND r.entry_type = $4)`,
      [input.referenceType, input.referenceId, input.entryType, input.reversalType, input.userId],
    );
  },

  findNegativeBalances(tx: Tx, outletId: string, itemIds: readonly string[]) {
    return tx.many<{ itemId: string; quantity: number }>(
      `SELECT item_id AS "itemId", quantity FROM stock_balances
       WHERE outlet_id = $1 AND item_id = ANY($2::uuid[]) AND quantity < 0`,
      [outletId, [...new Set(itemIds)]],
    );
  },

  /**
   * Moves the reserved quantity of one item by [delta]. Called only by the
   * sales-order service, which computes the delta from the order's own lines, so
   * the column is always the sum of what open orders still owe.
   *
   * Clamped at zero rather than allowed to fail: a CHECK violation here would make
   * an order impossible to save or cancel, and the reconciliation check is what
   * catches a column that has drifted.
   */
  async adjustReserved(
    tx: Tx,
    outletId: string,
    itemId: string,
    delta: number,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO stock_balances AS b (tenant_id, outlet_id, item_id, quantity, reserved)
       VALUES (app.current_tenant_id(), $1, $2, 0, GREATEST(0, $3::bigint))
       ON CONFLICT (tenant_id, outlet_id, item_id)
       DO UPDATE SET reserved = GREATEST(0, b.reserved + $3::bigint)`,
      [outletId, itemId, delta],
    );
  },

  /** Items that are promised for more than is on the shelf, among [itemIds]. */
  findReservedShortfalls(tx: Tx, outletId: string, itemIds: readonly string[]) {
    return tx.many<{ itemId: string; onHand: number; reserved: number }>(
      `SELECT item_id AS "itemId", quantity AS "onHand", reserved FROM stock_balances
       WHERE outlet_id = $1 AND item_id = ANY($2::uuid[]) AND quantity - reserved < 0`,
      [outletId, [...new Set(itemIds)]],
    );
  },

  /** What the order lines say should be reserved, to check the column against. */
  expectedReserved(tx: Tx, outletId: string | null) {
    return tx.many<{ outletId: string; itemId: string; reserved: number }>(
      `SELECT so.outlet_id AS "outletId", l.item_id AS "itemId",
              SUM(GREATEST(0, l.quantity - l.quantity_fulfilled))::bigint AS reserved
       FROM sales_order_lines l
       JOIN sales_orders so ON so.id = l.sales_order_id
       JOIN items i ON i.id = l.item_id
       WHERE so.deleted_at IS NULL AND so.status IN ('open', 'partial') AND i.track_stock
         AND ($1::uuid IS NULL OR so.outlet_id = $1)
       GROUP BY so.outlet_id, l.item_id
       HAVING SUM(GREATEST(0, l.quantity - l.quantity_fulfilled)) > 0`,
      [outletId],
    );
  },

  /** The reserved column as stored, for rows that carry any reservation. */
  storedReserved(tx: Tx, outletId: string | null) {
    return tx.many<{ outletId: string; itemId: string; reserved: number }>(
      `SELECT outlet_id AS "outletId", item_id AS "itemId", reserved FROM stock_balances
       WHERE reserved > 0 AND ($1::uuid IS NULL OR outlet_id = $1)`,
      [outletId],
    );
  },

  /**
   * Rewrites the column from the order lines. A repair, never part of a request:
   * the incremental path is the source of truth day to day.
   */
  async repairReserved(tx: Tx, outletId: string | null): Promise<void> {
    await tx.query(
      `UPDATE stock_balances SET reserved = 0
       WHERE reserved > 0 AND ($1::uuid IS NULL OR outlet_id = $1)`,
      [outletId],
    );
    await tx.query(
      `INSERT INTO stock_balances AS b (tenant_id, outlet_id, item_id, quantity, reserved)
       SELECT app.current_tenant_id(), e."outletId", e."itemId", 0, e.reserved
       FROM (
         SELECT so.outlet_id AS "outletId", l.item_id AS "itemId",
                SUM(GREATEST(0, l.quantity - l.quantity_fulfilled))::bigint AS reserved
         FROM sales_order_lines l
         JOIN sales_orders so ON so.id = l.sales_order_id
         JOIN items i ON i.id = l.item_id
         WHERE so.deleted_at IS NULL AND so.status IN ('open', 'partial') AND i.track_stock
           AND ($1::uuid IS NULL OR so.outlet_id = $1)
         GROUP BY so.outlet_id, l.item_id
         HAVING SUM(GREATEST(0, l.quantity - l.quantity_fulfilled)) > 0
       ) e
       ON CONFLICT (tenant_id, outlet_id, item_id) DO UPDATE SET reserved = EXCLUDED.reserved`,
      [outletId],
    );
  },

  /** On-hand and reserved quantity for one item at one outlet. */
  async levelFor(
    tx: Tx,
    outletId: string,
    itemId: string,
  ): Promise<{ onHand: number; reserved: number }> {
    const row = await tx.one<{ onHand: number; reserved: number }>(
      `SELECT quantity AS "onHand", reserved FROM stock_balances
       WHERE outlet_id = $1 AND item_id = $2`,
      [outletId, itemId],
    );
    return row ?? { onHand: 0, reserved: 0 };
  },

  findEntry(tx: Tx, id: string): Promise<StockEntryRow | undefined> {
    return tx.one<StockEntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM stock_ledger_entries WHERE id = $1`,
      [id],
    );
  },

  /** Locks the item so concurrent adjustments to it see each other's balance. */
  lockItem(tx: Tx, itemId: string) {
    return tx.one<{ id: string; trackStock: boolean }>(
      'SELECT id, track_stock AS "trackStock" FROM items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [itemId],
    );
  },

  async balanceFor(tx: Tx, outletId: string, itemId: string): Promise<number> {
    const row = await tx.one<{ quantity: number }>(
      'SELECT quantity FROM stock_balances WHERE outlet_id = $1 AND item_id = $2',
      [outletId, itemId],
    );
    return row?.quantity ?? 0;
  },

  listBalances(
    tx: Tx,
    filter: { outletId: string; itemId: string | undefined; belowReorder: boolean },
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<BalanceRow[]> {
    return tx.many<BalanceRow>(
      `SELECT sb.item_id AS "itemId", i.name AS "itemName", i.unit, sb.quantity, sb.reserved,
              sb.quantity - sb.reserved AS available, i.reorder_level AS "reorderLevel",
              sb.updated_at AS "updatedAt"
       FROM stock_balances sb JOIN items i ON i.id = sb.item_id
       WHERE sb.outlet_id = $1
         AND i.deleted_at IS NULL
         AND ($2::uuid IS NULL OR sb.item_id = $2)
         -- Low stock is measured on what can still be sold, not what is on the shelf.
         AND (NOT $3::boolean OR (i.reorder_level IS NOT NULL
                                  AND sb.quantity - sb.reserved <= i.reorder_level))
         AND ($4::text IS NULL OR (i.name, i.id) > ($4::text, $5::uuid))
       ORDER BY i.name, i.id
       LIMIT $6`,
      [
        filter.outletId,
        filter.itemId ?? null,
        filter.belowReorder,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  listLedger(
    tx: Tx,
    outletId: string,
    itemId: string,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<StockEntryRow[]> {
    return tx.many<StockEntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM stock_ledger_entries
       WHERE outlet_id = $1 AND item_id = $2
         AND ($3::timestamptz IS NULL OR (occurred_at, id) < ($3::timestamptz, $4::uuid))
       ORDER BY occurred_at DESC, id DESC
       LIMIT $5`,
      [outletId, itemId, cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },
};
