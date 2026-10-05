/**
 * Who sold what, where, and when — plus what they gave away doing it.
 *
 * These are the reports an owner reads to manage people rather than stock, so
 * each one names a person or a till. Three of them exist because a shop with
 * staff has questions a single-operator shop does not: which cashier is
 * discounting, which counter is busy, and which hour needs a second person on
 * it.
 *
 * `issued_by` is the user who billed, not the device: a cashier may move
 * between tills in a shift, and a report keyed on the device would credit the
 * till rather than the person.
 */
import type { Tx } from '../../../db/tx.js';
import { businessDay, dateRange, instantRange, outletScope } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

/** Cashier-wise sales: one row per person who billed in the window. */
export async function cashierWiseSales(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const userId = p.add(params.userId ?? null);
  const sql = `
    WITH sales AS (
      SELECT i.issued_by AS "userId",
             count(*)::int AS "billCount",
             SUM(i.grand_total)::bigint AS "grandTotal",
             SUM(i.line_discount_total + i.bill_discount_amount)::bigint AS "discount"
      FROM invoices i
      WHERE i.status = 'issued' AND ${outletScope(p, 'i', params)}
        AND ${dateRange(p, 'i.document_date', params)}
        AND (${userId}::uuid IS NULL OR i.issued_by = ${userId}::uuid)
      GROUP BY 1
    ),
    returns AS (
      SELECT c.issued_by AS "userId", SUM(c.grand_total)::bigint AS "returnTotal"
      FROM credit_notes c
      WHERE c.status = 'issued' AND ${outletScope(p, 'c', params)}
        AND ${dateRange(p, 'c.document_date', params)}
      GROUP BY 1
    ),
    voids AS (
      -- Counted against the person who voided, not the one who billed: a
      -- cashier voiding their own sales is the pattern worth seeing.
      SELECT i.voided_by AS "userId", count(*)::int AS "voidCount"
      FROM invoices i
      WHERE i.status = 'void' AND i.voided_by IS NOT NULL
        AND ${outletScope(p, 'i', params)} AND ${dateRange(p, 'i.document_date', params)}
      GROUP BY 1
    )
    SELECT u.name AS "userName", u.phone,
           COALESCE(s."billCount", 0) AS "billCount",
           COALESCE(s."grandTotal", 0) AS "grandTotal",
           COALESCE(r."returnTotal", 0) AS "returnTotal",
           COALESCE(s."grandTotal", 0) - COALESCE(r."returnTotal", 0) AS "netSales",
           COALESCE(s."discount", 0) AS "discount",
           COALESCE(v."voidCount", 0) AS "voidCount",
           CASE WHEN COALESCE(s."billCount", 0) = 0 THEN 0
                ELSE (COALESCE(s."grandTotal", 0) / s."billCount")::bigint END AS "averageBill"
    FROM sales s
    FULL OUTER JOIN returns r ON r."userId" = s."userId"
    FULL OUTER JOIN voids v ON v."userId" = COALESCE(s."userId", r."userId")
    JOIN users u ON u.id = COALESCE(s."userId", r."userId", v."userId")
    ORDER BY "netSales" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/** Counter-wise sales: which till took the money. */
export async function counterWiseSales(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const counterId = p.add(params.counterId ?? null);
  const sql = `
    SELECT o.name AS "outletName", COALESCE(ct.name, 'No counter') AS "counterName",
           count(*)::int AS "billCount",
           SUM(i.grand_total)::bigint AS "grandTotal",
           SUM(i.line_discount_total + i.bill_discount_amount)::bigint AS "discount",
           (SUM(i.grand_total) / count(*))::bigint AS "averageBill"
    FROM invoices i
    JOIN outlets o ON o.id = i.outlet_id
    LEFT JOIN counters ct ON ct.id = i.counter_id
    WHERE i.status = 'issued' AND ${outletScope(p, 'i', params)}
      AND ${dateRange(p, 'i.document_date', params)}
      AND (${counterId}::uuid IS NULL OR i.counter_id = ${counterId}::uuid)
    GROUP BY o.name, ct.name
    ORDER BY "grandTotal" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Hourly sales heatmap: one row per hour of the day, across the window.
 *
 * Grouped on `issued_at` rather than `document_date`, because the question is
 * what time of day the shop is busy and only the instant carries that. Read in
 * the shop's own timezone, or a shop in India would see its evening rush at
 * half past one in the afternoon.
 *
 * Offline bills are the known weakness: a device that billed at 7pm and
 * uploaded at 9pm still reports 7pm, because `issued_at` is the device's own
 * clock — which is right, and worth knowing if a device's clock is wrong.
 */
export async function hourlySalesHeatmap(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const localInstant = `(i.issued_at AT TIME ZONE ${p.add(params.timezone)})`;
  const sql = `
    SELECT EXTRACT(DOW FROM ${localInstant})::int AS "dayOfWeek",
           to_char(${localInstant}, 'Dy') AS "day",
           EXTRACT(HOUR FROM ${localInstant})::int AS "hour",
           count(*)::int AS "billCount",
           SUM(i.grand_total)::bigint AS "grandTotal",
           (SUM(i.grand_total) / count(*))::bigint AS "averageBill"
    FROM invoices i
    WHERE i.status = 'issued' AND ${outletScope(p, 'i', params)}
      AND ${instantRange(p, 'i.issued_at', params)}
    GROUP BY 1, 2, 3
    ORDER BY 1, 3
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Discount audit: every bill that gave money away, and who authorised it.
 *
 * The report the discount-cap feature exists to feed. It reads the approvals
 * table and the price provenance on each line, so a discount given over the
 * cap shows the approver's name beside it — and one given over the cap with
 * nobody's approval shows blank, which is the row an owner is looking for.
 */
export async function discountAudit(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const userId = p.add(params.userId ?? null);
  const sql = `
    SELECT i.document_date AS "date", i.document_number AS "documentNumber",
           COALESCE(i.customer_name, 'Walk-in') AS "customerName",
           biller.name AS "billedBy",
           i.gross_amount AS "grossAmount",
           i.line_discount_total AS "lineDiscount",
           i.bill_discount_amount AS "billDiscount",
           (i.line_discount_total + i.bill_discount_amount) AS "totalDiscount",
           CASE WHEN i.gross_amount = 0 THEN 0
                ELSE round(
                  (i.line_discount_total + i.bill_discount_amount) * 100.0 / i.gross_amount, 2)
                END AS "discountPercent",
           i.grand_total AS "grandTotal",
           -- Blank where a discount was given with nobody's authority, which
           -- is the row this report exists to surface.
           string_agg(DISTINCT approver.name, ', ') AS "approvedBy",
           string_agg(DISTINCT a.reason, '; ') AS "reason",
           MAX(a.breach_kind) AS "breachKind"
    FROM invoices i
    JOIN users biller ON biller.id = i.issued_by
    LEFT JOIN discount_approvals a ON a.invoice_id = i.id
    LEFT JOIN users approver ON approver.id = a.approved_by
    WHERE i.status = 'issued'
      AND (i.line_discount_total + i.bill_discount_amount) > 0
      AND ${outletScope(p, 'i', params)} AND ${dateRange(p, 'i.document_date', params)}
      AND (${userId}::uuid IS NULL OR i.issued_by = ${userId}::uuid)
    GROUP BY i.id, i.document_date, i.document_number, i.customer_name, biller.name,
             i.gross_amount, i.line_discount_total, i.bill_discount_amount, i.grand_total
    ORDER BY "totalDiscount" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Returns and voids: what was undone, by whom, and why.
 *
 * Both in one report because they answer the same suspicion from two
 * directions. A void erases a sale before it settles; a return reverses one
 * after. A cashier doing an unusual number of either is the pattern, and
 * splitting them across two screens hides it.
 */
export async function returnsAndVoids(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT 'return' AS kind, c.document_date AS "date", c.document_number AS "documentNumber",
           c.original_document_number AS "againstDocument",
           COALESCE(c.customer_name, 'Walk-in') AS "customerName",
           c.reason_code AS "reason", c.grand_total AS "amount",
           u.name AS "actionedBy", c.restock::text AS "restocked"
    FROM credit_notes c
    JOIN users u ON u.id = c.issued_by
    WHERE c.status = 'issued' AND ${outletScope(p, 'c', params)}
      AND ${dateRange(p, 'c.document_date', params)}
    UNION ALL
    SELECT 'void' AS kind, i.document_date AS "date", i.document_number AS "documentNumber",
           NULL AS "againstDocument",
           COALESCE(i.customer_name, 'Walk-in') AS "customerName",
           i.void_reason AS "reason", i.grand_total AS "amount",
           u.name AS "actionedBy", NULL AS "restocked"
    FROM invoices i
    JOIN users u ON u.id = COALESCE(i.voided_by, i.issued_by)
    WHERE i.status = 'void' AND ${outletScope(p, 'i', params)}
      AND ${dateRange(p, 'i.document_date', params)}
    ORDER BY "date" DESC, "documentNumber"
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Price-change history: what the shop charges now versus what it charged.
 *
 * Reads `audit_log` rather than a price-history table, because the trail
 * already records every price edit — `item.price_changed` has been written on
 * every catalogue update since M1, and `price_revision.applied` records a bulk
 * one. Adding a second store of the same fact would let the two disagree.
 */
export async function priceChangeHistory(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT ${businessDay(p, 'a.occurred_at', params)} AS "date",
           a.occurred_at AS "at",
           COALESCE(i.name, a.entity_id::text) AS "itemName",
           a.action,
           (a.changes -> 'salePrice' -> 'from')::text AS "oldPrice",
           (a.changes -> 'salePrice' -> 'to')::text AS "newPrice",
           u.name AS "changedBy"
    FROM audit_log a
    LEFT JOIN items i ON i.id = a.entity_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.action IN ('item.price_changed', 'price_revision.applied')
      AND ${instantRange(p, 'a.occurred_at', params)}
    ORDER BY a.occurred_at DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
