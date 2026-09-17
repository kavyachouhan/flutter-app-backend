/**
 * Sales reports. All of them exclude voided documents: a void did not happen
 * as far as turnover is concerned, and its number is accounted for separately
 * in the GSTR-1 gap report.
 *
 * Credit notes are subtracted where the figure is "what the shop earned" and
 * shown separately where the figure is "what was issued".
 */
import type { Tx } from '../../../db/tx.js';
import { dateRange, instantRange, outletScope } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

/** Sales summary: one row per business day. */
export async function salesSummary(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  // Grouped by the document date, which is what the range filters on and what
  // a merchant means by "the 14th" — not `issued_at`, which is when the device
  // happened to upload a bill it may have written offline days earlier.
  const sql = `
    WITH sales AS (
      SELECT i.document_date AS "date",
             count(*)::int AS "billCount",
             SUM(i.taxable_amount)::bigint AS "taxableAmount",
             SUM(i.total_tax)::bigint AS "taxAmount",
             SUM(i.line_discount_total + i.bill_discount_amount)::bigint AS "discount",
             SUM(i.grand_total)::bigint AS "grandTotal"
      FROM invoices i
      WHERE i.status = 'issued' AND ${outletScope(p, 'i', params)} AND ${dateRange(p, 'i.document_date', params)}
      GROUP BY 1
    ),
    returns AS (
      SELECT c.document_date AS "date",
             SUM(c.grand_total)::bigint AS "returnTotal"
      FROM credit_notes c
      WHERE c.status = 'issued' AND ${outletScope(p, 'c', params)} AND ${dateRange(p, 'c.document_date', params)}
      GROUP BY 1
    )
    SELECT COALESCE(s."date", r."date") AS "date",
           COALESCE(s."billCount", 0) AS "billCount",
           COALESCE(s."taxableAmount", 0) AS "taxableAmount",
           COALESCE(s."taxAmount", 0) AS "taxAmount",
           COALESCE(s."discount", 0) AS "discount",
           COALESCE(s."grandTotal", 0) AS "grandTotal",
           COALESCE(r."returnTotal", 0) AS "returnTotal",
           COALESCE(s."grandTotal", 0) - COALESCE(r."returnTotal", 0) AS "netSales"
    FROM sales s FULL OUTER JOIN returns r ON r."date" = s."date"
    ORDER BY 1
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/** Bill register: every invoice issued, for reconciliation and audit. */
export async function billRegister(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT i.document_date AS "date",
           i.document_number AS "documentNumber",
           i.issued_at AS "issuedAt",
           COALESCE(i.customer_name, 'Walk-in') AS "customer",
           i.customer_gstin AS "customerGstin",
           i.taxable_amount AS "taxableAmount",
           i.total_tax AS "taxAmount",
           i.grand_total AS "grandTotal",
           i.status
    FROM invoices i
    WHERE ${outletScope(p, 'i', params)} AND ${dateRange(p, 'i.document_date', params)}
      AND (${p.add(params.customerId ?? null)}::uuid IS NULL OR i.customer_id = ${p.add(params.customerId ?? null)}::uuid)
    ORDER BY i.document_date, i.document_number
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Item-wise sales. Reads the denormalised outlet and date on `invoice_lines`,
 * which is why that column exists: without it this scans the tenant's whole
 * line history.
 */
export async function itemWiseSales(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const categoryId = p.add(params.categoryId ?? null);
  const itemId = p.add(params.itemId ?? null);
  const sql = `
    SELECT l.item_name AS "itemName",
           cat.name AS "category",
           SUM(l.quantity)::bigint AS "quantity",
           SUM(l.taxable_amount)::bigint AS "taxableAmount",
           SUM(l.cgst + l.sgst + l.igst + l.cess)::bigint AS "taxAmount",
           SUM(l.line_total)::bigint AS "lineTotal",
           SUM(l.line_discount + l.bill_discount_share)::bigint AS "discount"
    FROM invoice_lines l
    JOIN invoices i ON i.id = l.invoice_id
    LEFT JOIN items it ON it.id = l.item_id
    LEFT JOIN categories cat ON cat.id = it.category_id
    WHERE i.status = 'issued' AND ${outletScope(p, 'l', params)} AND ${dateRange(p, 'l.document_date', params)}
      AND (${categoryId}::uuid IS NULL OR it.category_id = ${categoryId}::uuid)
      AND (${itemId}::uuid IS NULL OR l.item_id = ${itemId}::uuid)
    GROUP BY l.item_name, cat.name
    ORDER BY SUM(l.line_total) DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

export async function categoryWiseSales(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT COALESCE(cat.name, 'Uncategorised') AS "category",
           count(DISTINCT l.invoice_id)::int AS "billCount",
           SUM(l.quantity)::bigint AS "quantity",
           SUM(l.taxable_amount)::bigint AS "taxableAmount",
           SUM(l.line_total)::bigint AS "lineTotal"
    FROM invoice_lines l
    JOIN invoices i ON i.id = l.invoice_id
    LEFT JOIN items it ON it.id = l.item_id
    LEFT JOIN categories cat ON cat.id = it.category_id
    WHERE i.status = 'issued' AND ${outletScope(p, 'l', params)} AND ${dateRange(p, 'l.document_date', params)}
    GROUP BY cat.name
    ORDER BY SUM(l.line_total) DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Payment-mode split. Attributed by the payment row, not the invoice, so a
 * split-tender bill contributes to each mode it was paid with. Refunds are
 * subtracted, which is what makes this tie to the drawer.
 */
export async function paymentModeSplit(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT pm.mode,
           SUM(CASE WHEN pm.kind = 'invoice_tender' THEN pm.amount ELSE 0 END)::bigint AS "atBilling",
           SUM(CASE WHEN pm.kind = 'receipt' THEN pm.amount ELSE 0 END)::bigint AS "collections",
           SUM(CASE WHEN pm.kind = 'refund' THEN pm.amount ELSE 0 END)::bigint AS "refunds",
           SUM(CASE WHEN pm.kind = 'refund' THEN -pm.amount ELSE pm.amount END)::bigint AS "net",
           count(*)::int AS "txnCount"
    FROM payments pm
    WHERE pm.status = 'issued' AND ${outletScope(p, 'pm', params)} AND ${instantRange(p, 'pm.received_at', params)}
    GROUP BY pm.mode
    ORDER BY 5 DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Day book: every money movement in the window, in the order it happened.
 * The one report a shopkeeper opens to answer "where did the day go".
 */
export async function dayBook(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    SELECT * FROM (
      SELECT i.issued_at AS "at", 'Sale' AS "type", i.document_number AS "reference",
             COALESCE(i.customer_name, 'Walk-in') AS "party",
             i.grand_total AS "amount", 0::bigint AS "outflow", i.status
      FROM invoices i
      WHERE ${outletScope(p, 'i', params)} AND ${instantRange(p, 'i.issued_at', params)}
        AND i.status = 'issued'

      UNION ALL
      SELECT c.issued_at, 'Return', c.document_number, COALESCE(c.customer_name, 'Walk-in'),
             0::bigint, c.grand_total, c.status
      FROM credit_notes c
      WHERE ${outletScope(p, 'c', params)} AND ${instantRange(p, 'c.issued_at', params)}
        AND c.status = 'issued'

      UNION ALL
      SELECT pm.received_at, 'Receipt', COALESCE(pm.reference, pm.mode), COALESCE(cu.name, '-'),
             pm.amount, 0::bigint, pm.status
      FROM payments pm LEFT JOIN customers cu ON cu.id = pm.customer_id
      WHERE ${outletScope(p, 'pm', params)} AND ${instantRange(p, 'pm.received_at', params)}
        AND pm.status = 'issued' AND pm.kind = 'receipt'

      UNION ALL
      SELECT e.spent_at, 'Expense', COALESCE(e.reference, ec.name, 'Expense'),
             COALESCE(e.vendor_name, '-'), 0::bigint, e.amount, e.status
      FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
      WHERE ${outletScope(p, 'e', params)} AND ${instantRange(p, 'e.spent_at', params)}
        AND e.status = 'issued'
    ) entries
    ORDER BY "at"
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
