/**
 * Stock reports, read from the trigger-maintained `stock_balances` projection
 * rather than by summing the ledger: the projection is what the till reads at
 * billing time, so a report that disagreed with it would be reporting on a
 * different shop.
 */
import type { Tx } from '../../../db/tx.js';
import { dateRange, outletScope } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

export async function currentStock(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const categoryId = p.add(params.categoryId ?? null);
  const sql = `
    SELECT i.name AS "itemName",
           COALESCE(c.name, 'Uncategorised') AS "category",
           i.unit,
           COALESCE(sb.quantity, 0) AS "quantity",
           i.purchase_price AS "unitCost",
           i.sale_price AS "salePrice",
           (COALESCE(sb.quantity, 0) * COALESCE(i.purchase_price, 0) / 1000)::bigint AS "stockValue",
           i.reorder_level AS "reorderLevel"
    FROM stock_balances sb
    JOIN items i ON i.id = sb.item_id
    LEFT JOIN categories c ON c.id = i.category_id
    WHERE i.deleted_at IS NULL AND i.track_stock AND ${outletScope(p, 'sb', params)}
      AND (${categoryId}::uuid IS NULL OR i.category_id = ${categoryId}::uuid)
    ORDER BY i.name
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/** Items at or below their reorder level; the buying list. */
export async function lowStock(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT i.name AS "itemName",
           COALESCE(c.name, 'Uncategorised') AS "category",
           i.unit,
           COALESCE(sb.quantity, 0) AS "quantity",
           i.reorder_level AS "reorderLevel",
           (i.reorder_level - COALESCE(sb.quantity, 0)) AS "shortfall",
           i.purchase_price AS "unitCost"
    FROM items i
    LEFT JOIN stock_balances sb ON sb.item_id = i.id AND ${outletScope(p, 'sb', params)}
    LEFT JOIN categories c ON c.id = i.category_id
    WHERE i.deleted_at IS NULL AND i.track_stock AND i.is_active
      AND i.reorder_level IS NOT NULL
      AND COALESCE(sb.quantity, 0) <= i.reorder_level
    ORDER BY (i.reorder_level - COALESCE(sb.quantity, 0)) DESC, i.name
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Fast and dead stock in one view: units sold in the window beside what is
 * still on the shelf. A row with stock and no sales is money sitting still.
 */
export async function stockMovement(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH sold AS (
      SELECT l.item_id, SUM(l.quantity)::bigint AS "quantitySold",
             SUM(l.line_total)::bigint AS "salesValue",
             MAX(l.document_date) AS "lastSoldOn"
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND l.item_id IS NOT NULL
        AND ${outletScope(p, 'l', params)} AND ${dateRange(p, 'l.document_date', params)}
      GROUP BY l.item_id
    )
    SELECT i.name AS "itemName",
           COALESCE(c.name, 'Uncategorised') AS "category",
           i.unit,
           COALESCE(s."quantitySold", 0) AS "quantitySold",
           COALESCE(s."salesValue", 0) AS "salesValue",
           s."lastSoldOn",
           COALESCE(sb.quantity, 0) AS "onHand"
    FROM items i
    LEFT JOIN sold s ON s.item_id = i.id
    LEFT JOIN stock_balances sb ON sb.item_id = i.id AND ${outletScope(p, 'sb', params)}
    LEFT JOIN categories c ON c.id = i.category_id
    WHERE i.deleted_at IS NULL AND i.track_stock
    ORDER BY COALESCE(s."quantitySold", 0) DESC, i.name
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
