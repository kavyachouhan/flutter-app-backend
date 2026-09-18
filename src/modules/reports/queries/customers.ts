/**
 * Customer reports. Balances come from the trigger-maintained
 * `customer_balances` projection, which is the same number the till shows at
 * billing — a report that recomputed it from the ledger could disagree, and
 * then nobody would know which one to believe.
 */
import type { Tx } from '../../../db/tx.js';
import { instantRange } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

/**
 * Who owes money, oldest debt first, with a simple ageing split.
 *
 * Not outlet-scoped: a customer's khata belongs to the business, not to the
 * branch that happened to serve them, and paying at one branch must settle
 * what was bought at another.
 */
export async function customerOutstanding(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH ageing AS (
      SELECT i.customer_id,
             SUM(CASE WHEN now() - i.issued_at <= interval '30 days'
                      THEN i.grand_total - COALESCE(paid.amount, 0) ELSE 0 END)::bigint AS "days0to30",
             SUM(CASE WHEN now() - i.issued_at > interval '30 days' AND now() - i.issued_at <= interval '60 days'
                      THEN i.grand_total - COALESCE(paid.amount, 0) ELSE 0 END)::bigint AS "days31to60",
             SUM(CASE WHEN now() - i.issued_at > interval '60 days' AND now() - i.issued_at <= interval '90 days'
                      THEN i.grand_total - COALESCE(paid.amount, 0) ELSE 0 END)::bigint AS "days61to90",
             SUM(CASE WHEN now() - i.issued_at > interval '90 days'
                      THEN i.grand_total - COALESCE(paid.amount, 0) ELSE 0 END)::bigint AS "days90plus",
             MIN(i.document_date) FILTER (WHERE i.grand_total > COALESCE(paid.amount, 0)) AS "oldestUnpaid"
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount)::bigint AS amount
        FROM payment_allocations pa JOIN payments pm ON pm.id = pa.payment_id
        WHERE pa.invoice_id = i.id AND pm.status = 'issued'
      ) paid ON true
      WHERE i.status = 'issued' AND i.customer_id IS NOT NULL
        AND i.grand_total > COALESCE(paid.amount, 0)
      GROUP BY i.customer_id
    )
    SELECT c.name AS "customer",
           c.phone,
           b.balance AS "balance",
           c.credit_limit AS "creditLimit",
           COALESCE(a."days0to30", 0) AS "days0to30",
           COALESCE(a."days31to60", 0) AS "days31to60",
           COALESCE(a."days61to90", 0) AS "days61to90",
           COALESCE(a."days90plus", 0) AS "days90plus",
           a."oldestUnpaid"
    FROM customer_balances b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN ageing a ON a.customer_id = b.customer_id
    WHERE c.deleted_at IS NULL AND b.balance <> 0
      AND (${p.add(params.customerId ?? null)}::uuid IS NULL OR c.id = ${p.add(params.customerId ?? null)}::uuid)
    ORDER BY b.balance DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * One customer's khata, as it would be printed and handed over. Requires a
 * customer: a statement across everybody is the outstanding report above.
 */
export async function khataStatement(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const customerId = p.add(params.customerId ?? null);
  const sql = `
    SELECT e.occurred_at AS "at",
           CASE e.entry_type
             WHEN 'opening_balance' THEN 'Opening balance'
             WHEN 'invoice' THEN 'Sale'
             WHEN 'invoice_void' THEN 'Sale cancelled'
             WHEN 'payment' THEN 'Payment received'
             WHEN 'payment_void' THEN 'Payment cancelled'
             WHEN 'credit_note' THEN 'Return'
             WHEN 'credit_note_void' THEN 'Return cancelled'
             WHEN 'refund' THEN 'Refund paid'
             WHEN 'refund_void' THEN 'Refund cancelled'
             ELSE e.entry_type
           END AS "particulars",
           e.note AS "reference",
           e.debit,
           e.credit,
           SUM(e.debit - e.credit) OVER (ORDER BY e.occurred_at, e.id)::bigint AS "balance"
    FROM customer_ledger_entries e
    WHERE e.customer_id = ${customerId}::uuid
      AND ${instantRange(p, 'e.occurred_at', params)}
    ORDER BY e.occurred_at, e.id
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
