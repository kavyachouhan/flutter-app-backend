/**
 * Gross margin, stock valuation and the stock ledger.
 *
 * Every margin figure here reads `invoice_lines.cogs_amount` — the
 * moving-average cost snapshotted onto the line at the moment of sale — and
 * never the item's current cost. That distinction is the whole point: costing
 * a March sale at today's buying price makes margin restate itself every time
 * a supplier raises a price, which is the bug the snapshot was added to fix.
 *
 * Lines with no snapshot (sold before costing existed, or an item never
 * purchased through the system) are reported as *unknown*, never as zero. Zero
 * cost reads as pure profit, which would quietly overstate margin on exactly
 * the items nobody has cost data for.
 */
import type { Tx } from '../../../db/tx.js';
import { dateRange, outletScope } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

/** The margin columns every margin report shares, given a grouping alias. */
function marginSelect(): string {
  return `
    SUM(l.taxable_amount)::bigint AS "revenue",
    SUM(l.cogs_amount)::bigint AS "cost",
    (SUM(l.taxable_amount) - COALESCE(SUM(l.cogs_amount), 0))::bigint AS "margin",
    CASE WHEN SUM(l.taxable_amount) = 0 THEN 0
         ELSE round((SUM(l.taxable_amount) - COALESCE(SUM(l.cogs_amount), 0)) * 100.0
                    / SUM(l.taxable_amount), 2) END AS "marginPercent",
    -- How much of the revenue has a real cost behind it. A margin computed
    -- over half-unknown costs is not wrong so much as not yet an answer, and
    -- this is the column that says so.
    count(*) FILTER (WHERE l.cogs_amount IS NULL)::int AS "linesWithoutCost"`;
}

/** Gross margin by item. */
export async function grossMarginByItem(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const categoryId = p.add(params.categoryId ?? null);
  const itemId = p.add(params.itemId ?? null);
  const sql = `
    SELECT COALESCE(it.name, l.item_name) AS "itemName", cat.name AS "categoryName",
           SUM(l.quantity)::bigint AS "quantity",
           ${marginSelect()}
    FROM invoice_lines l
    JOIN invoices i ON i.id = l.invoice_id
    LEFT JOIN items it ON it.id = l.item_id
    LEFT JOIN categories cat ON cat.id = it.category_id
    WHERE i.status = 'issued' AND ${outletScope(p, 'l', params)}
      AND ${dateRange(p, 'l.document_date', params)}
      AND (${categoryId}::uuid IS NULL OR it.category_id = ${categoryId}::uuid)
      AND (${itemId}::uuid IS NULL OR l.item_id = ${itemId}::uuid)
    GROUP BY COALESCE(it.name, l.item_name), cat.name
    ORDER BY "margin" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/** Gross margin by category. */
export async function grossMarginByCategory(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT COALESCE(cat.name, 'Uncategorised') AS "categoryName",
           count(DISTINCT l.item_id)::int AS "itemCount",
           SUM(l.quantity)::bigint AS "quantity",
           ${marginSelect()}
    FROM invoice_lines l
    JOIN invoices i ON i.id = l.invoice_id
    LEFT JOIN items it ON it.id = l.item_id
    LEFT JOIN categories cat ON cat.id = it.category_id
    WHERE i.status = 'issued' AND ${outletScope(p, 'l', params)}
      AND ${dateRange(p, 'l.document_date', params)}
    GROUP BY COALESCE(cat.name, 'Uncategorised')
    ORDER BY "margin" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Stock valuation: what the stock on hand is worth at cost.
 *
 * At cost, not at selling price. Valuing stock at what the shop hopes to sell
 * it for is the classic way to overstate assets, and it is not what any
 * accountant or lender will accept.
 *
 * An item with stock and no cost is listed with a null value rather than
 * excluded: the total understates by that much and the row says why, which is
 * better than a tidy figure that is quietly short.
 */
export async function stockValuation(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const categoryId = p.add(params.categoryId ?? null);
  const sql = `
    SELECT it.name AS "itemName", COALESCE(cat.name, 'Uncategorised') AS "categoryName",
           o.name AS "outletName", it.unit,
           sb.quantity AS "quantity",
           ic.avg_cost AS "unitCost",
           (sb.quantity * ic.avg_cost / 1000)::bigint AS "value",
           it.sale_price AS "salePrice",
           (sb.quantity * it.sale_price / 1000)::bigint AS "retailValue"
    FROM stock_balances sb
    JOIN items it ON it.id = sb.item_id
    JOIN outlets o ON o.id = sb.outlet_id
    LEFT JOIN categories cat ON cat.id = it.category_id
    LEFT JOIN item_costs ic ON ic.item_id = sb.item_id AND ic.outlet_id = sb.outlet_id
    WHERE it.deleted_at IS NULL AND sb.quantity <> 0
      AND ${outletScope(p, 'sb', params)}
      AND (${categoryId}::uuid IS NULL OR it.category_id = ${categoryId}::uuid)
    ORDER BY "value" DESC NULLS LAST
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Stock ledger for one item: every movement, with a running balance.
 *
 * Needs an `itemId`; without one it would be every item's movements
 * interleaved, which is not a document anyone wants — the same reason the
 * khata statement requires a customer.
 *
 * The running balance is a window function over the ledger rather than a read
 * of `stock_balances`, so the column reconciles line by line and a discrepancy
 * between the two becomes visible instead of being papered over.
 */
export async function stockLedger(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const itemId = p.add(params.itemId ?? null);
  const sql = `
    SELECT e.occurred_at AS "at", e.entry_type AS "entryType",
           e.reference_type AS "referenceType",
           e.quantity_delta AS "change",
           SUM(e.quantity_delta) OVER (
             PARTITION BY e.item_id, e.outlet_id ORDER BY e.occurred_at, e.id
           )::bigint AS "balance",
           o.name AS "outletName", e.reason_code AS "reason",
           u.name AS "createdBy", e.note
    FROM stock_ledger_entries e
    JOIN outlets o ON o.id = e.outlet_id
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.item_id = ${itemId}::uuid
      AND ${outletScope(p, 'e', params)}
      AND ${dateRange(p, '(e.occurred_at)::date', params)}
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
