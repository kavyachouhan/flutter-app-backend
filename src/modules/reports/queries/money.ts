/**
 * Money reports: what was spent, and what the day actually earned.
 */
import type { Tx } from '../../../db/tx.js';
import { businessDay, dateRange, instantRange, outletScope } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

export async function expenseSummary(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT COALESCE(c.name, 'Uncategorised') AS "category",
           c.is_direct AS "isDirect",
           count(*)::int AS "entryCount",
           SUM(e.amount)::bigint AS "amount",
           SUM(CASE WHEN e.mode = 'cash' THEN e.amount ELSE 0 END)::bigint AS "paidInCash"
    FROM expenses e
    LEFT JOIN expense_categories c ON c.id = e.category_id
    WHERE e.status = 'issued' AND ${outletScope(p, 'e', params)} AND ${instantRange(p, 'e.spent_at', params)}
      AND (${p.add(params.categoryId ?? null)}::uuid IS NULL OR e.category_id = ${p.add(params.categoryId ?? null)}::uuid)
    GROUP BY c.name, c.is_direct
    ORDER BY SUM(e.amount) DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Daily P&L.
 *
 * Cost of goods uses each item's **current** purchase price, because nothing
 * yet records what a unit actually cost when it was bought — moving-average
 * cost arrives with purchase bills. The column is labelled "estimated" for
 * that reason, and it is the one figure here a merchant should not take to
 * their accountant.
 */
export async function dailyProfitAndLoss(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH sales AS (
      SELECT i.document_date AS "date",
             SUM(i.taxable_amount)::bigint AS "netSales",
             SUM(i.total_tax)::bigint AS "taxCollected"
      FROM invoices i
      WHERE i.status = 'issued' AND ${outletScope(p, 'i', params)} AND ${dateRange(p, 'i.document_date', params)}
      GROUP BY 1
    ),
    returns AS (
      SELECT c.document_date AS "date",
             SUM(c.taxable_amount)::bigint AS "returns"
      FROM credit_notes c
      WHERE c.status = 'issued' AND ${outletScope(p, 'c', params)} AND ${dateRange(p, 'c.document_date', params)}
      GROUP BY 1
    ),
    -- Cost of goods sold.
    --
    -- Prefers l.cogs_amount, the moving-average cost snapshotted onto the
    -- line when it was sold. Falling back to the item's *current* purchase
    -- price, as this report used to do throughout, restates history every
    -- time a buying price moves — a sale made last month silently changes
    -- its own margin.
    --
    -- The fallback remains for lines sold before costing existed, and
    -- "costedLines" reports how many lines the figure actually covers so a
    -- partly-estimated margin is visible as such rather than presented as
    -- fact.
    cost AS (
      SELECT l.document_date AS "date",
             SUM(COALESCE(l.cogs_amount,
                          l.quantity * COALESCE(it.purchase_price, 0) / 1000))::bigint
               AS "estimatedCost",
             count(*) FILTER (WHERE l.cogs_amount IS NOT NULL)::int AS "costedLines",
             count(*)::int AS "totalLines"
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
      LEFT JOIN items it ON it.id = l.item_id
      WHERE i.status = 'issued' AND ${outletScope(p, 'l', params)} AND ${dateRange(p, 'l.document_date', params)}
      GROUP BY 1
    ),
    spend AS (
      SELECT ${businessDay(p, 'e.spent_at', params)} AS "date",
             SUM(CASE WHEN COALESCE(ec.is_direct, false) THEN e.amount ELSE 0 END)::bigint AS "directExpenses",
             SUM(CASE WHEN COALESCE(ec.is_direct, false) THEN 0 ELSE e.amount END)::bigint AS "indirectExpenses"
      FROM expenses e
      LEFT JOIN expense_categories ec ON ec.id = e.category_id
      WHERE e.status = 'issued' AND ${outletScope(p, 'e', params)} AND ${instantRange(p, 'e.spent_at', params)}
      GROUP BY 1
    ),
    days AS (
      SELECT "date" FROM sales
      UNION SELECT "date" FROM returns
      UNION SELECT "date" FROM cost
      UNION SELECT "date" FROM spend
    )
    SELECT d."date",
           COALESCE(s."netSales", 0) - COALESCE(r."returns", 0) AS "netSales",
           COALESCE(k."estimatedCost", 0) AS "estimatedCost",
           -- "Estimated" when some lines fell back to the item's current
           -- purchase price, so an approximate margin is visible as such
           -- instead of being presented as fact.
           CASE WHEN COALESCE(k."costedLines", 0) = COALESCE(k."totalLines", 0)
                THEN 'Actual' ELSE 'Estimated' END AS "costBasis",
           COALESCE(s."netSales", 0) - COALESCE(r."returns", 0) - COALESCE(k."estimatedCost", 0) AS "grossMargin",
           COALESCE(x."directExpenses", 0) AS "directExpenses",
           COALESCE(x."indirectExpenses", 0) AS "indirectExpenses",
           COALESCE(s."netSales", 0) - COALESCE(r."returns", 0) - COALESCE(k."estimatedCost", 0)
             - COALESCE(x."directExpenses", 0) - COALESCE(x."indirectExpenses", 0) AS "netProfit"
    FROM days d
    LEFT JOIN sales s ON s."date" = d."date"
    LEFT JOIN returns r ON r."date" = d."date"
    LEFT JOIN cost k ON k."date" = d."date"
    LEFT JOIN spend x ON x."date" = d."date"
    ORDER BY d."date"
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
