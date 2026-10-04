/**
 * The buying side and the cash position: purchases, payables, and what the
 * shop owes against what it is owed.
 *
 * Ageing is computed from `due_date` where a document has one and from the
 * document date where it does not, because a supplier with no agreed terms is
 * owed on invoice — and treating an undated payable as never due is how a shop
 * discovers an overdue account from the supplier rather than from its own
 * books.
 */
import type { Tx } from '../../../db/tx.js';
import { businessDay, dateRange, instantRange, outletScope } from '../reports.filters.js';
import { Params, type ReportParams, type ReportRow } from '../reports.types.js';

/** Purchase register: every bill entered, for reconciliation against 2B. */
export async function purchaseRegister(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const supplierId = p.add(params.supplierId ?? null);
  const sql = `
    SELECT b.supplier_invoice_date AS "billDate", b.document_number AS "ourNumber",
           b.supplier_invoice_no AS "supplierNumber", s.name AS "supplierName",
           b.supplier_gstin AS "supplierGstin",
           b.taxable_amount AS "taxableAmount",
           (b.total_cgst + b.total_sgst + b.total_igst + b.total_cess)::bigint AS "taxAmount",
           b.grand_total AS "grandTotal",
           b.itc_eligible::text AS "itcEligible",
           COALESCE(b.itc_category, '-') AS "itcCategory",
           b.is_reverse_charge::text AS "reverseCharge",
           b.status,
           b.due_date AS "dueDate"
    FROM purchase_bills b
    JOIN suppliers s ON s.id = b.supplier_id
    WHERE ${outletScope(p, 'b', params)}
      AND ${dateRange(p, 'b.supplier_invoice_date', params)}
      AND (${supplierId}::uuid IS NULL OR b.supplier_id = ${supplierId}::uuid)
    ORDER BY b.supplier_invoice_date DESC, b.document_number
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/** Supplier-wise purchases: who the shop buys from, and how much it returns. */
export async function supplierWisePurchases(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const sql = `
    WITH bills AS (
      SELECT b.supplier_id, count(*)::int AS "billCount",
             SUM(b.taxable_amount)::bigint AS "taxableAmount",
             SUM(b.total_cgst + b.total_sgst + b.total_igst + b.total_cess)::bigint AS "taxAmount",
             SUM(b.grand_total)::bigint AS "grandTotal"
      FROM purchase_bills b
      WHERE b.status <> 'void' AND ${outletScope(p, 'b', params)}
        AND ${dateRange(p, 'b.supplier_invoice_date', params)}
      GROUP BY 1
    ),
    returns AS (
      SELECT d.supplier_id, SUM(d.grand_total)::bigint AS "returnTotal"
      FROM debit_notes d
      WHERE d.status <> 'void' AND ${outletScope(p, 'd', params)}
        AND ${dateRange(p, 'd.document_date', params)}
      GROUP BY 1
    )
    SELECT s.name AS "supplierName", s.gstin,
           s.registration_type AS "registrationType",
           COALESCE(b."billCount", 0) AS "billCount",
           COALESCE(b."taxableAmount", 0) AS "taxableAmount",
           COALESCE(b."taxAmount", 0) AS "taxAmount",
           COALESCE(b."grandTotal", 0) AS "grandTotal",
           COALESCE(r."returnTotal", 0) AS "returnTotal",
           COALESCE(b."grandTotal", 0) - COALESCE(r."returnTotal", 0) AS "netPurchases",
           -- What is still owed, from the trigger-maintained projection rather
           -- than re-summed here: one source of truth for the balance.
           COALESCE(sb.balance, 0) AS "outstanding"
    FROM bills b
    FULL OUTER JOIN returns r ON r.supplier_id = b.supplier_id
    JOIN suppliers s ON s.id = COALESCE(b.supplier_id, r.supplier_id)
    LEFT JOIN supplier_balances sb ON sb.supplier_id = s.id
    ORDER BY "netPurchases" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Purchase order status: what has been ordered and how much has arrived.
 *
 * The reorder loop's open end. An order part-received and then forgotten is
 * stock the shop thinks is coming and money a supplier thinks is committed,
 * and nothing else in the system shows it.
 */
export async function purchaseOrderStatus(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const supplierId = p.add(params.supplierId ?? null);
  const sql = `
    SELECT po.document_number AS "orderNumber", po.document_date AS "orderDate",
           s.name AS "supplierName", po.status,
           po.expected_date AS "expectedDate",
           CASE WHEN po.expected_date IS NULL THEN NULL
                ELSE (CURRENT_DATE - po.expected_date) END AS "daysLate",
           po.estimated_total AS "orderValue",
           COALESCE(SUM(pol.quantity_ordered), 0)::bigint AS "orderedQuantity",
           COALESCE(SUM(pol.quantity_received), 0)::bigint AS "receivedQuantity",
           COALESCE(SUM(pol.quantity_ordered - pol.quantity_received), 0)::bigint AS "pendingQuantity"
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    WHERE ${outletScope(p, 'po', params)}
      AND ${dateRange(p, 'po.document_date', params)}
      AND (${supplierId}::uuid IS NULL OR po.supplier_id = ${supplierId}::uuid)
    GROUP BY po.id, po.document_number, po.document_date, s.name, po.status,
             po.expected_date, po.estimated_total
    ORDER BY po.document_date DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/** The ageing buckets both ageing reports use, over a days-overdue expression. */
function ageingBuckets(days: string, amount: string): string {
  return `
    SUM(CASE WHEN ${days} <= 30 THEN ${amount} ELSE 0 END)::bigint AS "days0to30",
    SUM(CASE WHEN ${days} BETWEEN 31 AND 60 THEN ${amount} ELSE 0 END)::bigint AS "days31to60",
    SUM(CASE WHEN ${days} BETWEEN 61 AND 90 THEN ${amount} ELSE 0 END)::bigint AS "days61to90",
    SUM(CASE WHEN ${days} > 90 THEN ${amount} ELSE 0 END)::bigint AS "days90plus"`;
}

/**
 * Payables ageing: what the shop owes, by how overdue it is.
 *
 * Not outlet-scoped, deliberately — the same decision the customer-outstanding
 * report makes. What a business owes a supplier is owed by the business, not by
 * the branch that happened to receive the goods, and splitting it by outlet
 * would produce four partial balances that no supplier would recognise.
 */
export async function payablesAgeing(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const supplierId = p.add(params.supplierId ?? null);
  const days = 'CURRENT_DATE - COALESCE(b.due_date, b.supplier_invoice_date)';
  const outstanding = '(b.grand_total - COALESCE(paid.amount, 0))';
  const sql = `
    WITH paid AS (
      SELECT sp.purchase_bill_id AS bill_id, SUM(sp.amount)::bigint AS amount
      FROM supplier_payment_allocations sp
      GROUP BY 1
    )
    SELECT s.name AS "supplierName", s.phone,
           count(*)::int AS "billCount",
           SUM(${outstanding})::bigint AS "outstanding",
           ${ageingBuckets(days, outstanding)},
           MAX(${days})::int AS "oldestDays"
    FROM purchase_bills b
    JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN paid ON paid.bill_id = b.id
    WHERE b.status <> 'void' AND ${outstanding} > 0
      AND (${supplierId}::uuid IS NULL OR b.supplier_id = ${supplierId}::uuid)
    GROUP BY s.id, s.name, s.phone
    ORDER BY "outstanding" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Receivables ageing: what customers owe, by how overdue.
 *
 * The counterpart to payables, and the pair an owner reads together to answer
 * "can I pay my suppliers out of what is coming in". Customer-outstanding
 * already lists balances per customer; this one buckets them by age, which is
 * the view that says which debts have stopped moving.
 */
export async function receivablesAgeing(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const customerId = p.add(params.customerId ?? null);
  const days = 'CURRENT_DATE - i.document_date';
  const outstanding = '(i.grand_total - COALESCE(paid.amount, 0))';
  const sql = `
    WITH paid AS (
      SELECT pa.invoice_id, SUM(pa.amount)::bigint AS amount
      FROM payment_allocations pa
      GROUP BY 1
    )
    SELECT c.name AS "customerName", c.phone,
           count(*)::int AS "billCount",
           SUM(${outstanding})::bigint AS "outstanding",
           ${ageingBuckets(days, outstanding)},
           MAX(${days})::int AS "oldestDays",
           c.credit_limit AS "creditLimit"
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN paid ON paid.invoice_id = i.id
    WHERE i.status = 'issued' AND ${outstanding} > 0
      AND (${customerId}::uuid IS NULL OR i.customer_id = ${customerId}::uuid)
    GROUP BY c.id, c.name, c.phone, c.credit_limit
    ORDER BY "outstanding" DESC
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}

/**
 * Cash flow: money in and money out, per business day.
 *
 * Built from `payments` and `expenses` rather than from invoices, because this
 * report is about cash and a credit sale is not cash. An invoice billed to a
 * customer's khata moves no money until the payment arrives, and a cash-flow
 * report that counted it would tell a shop it is solvent when it is not.
 */
export async function cashFlow(tx: Tx, params: ReportParams): Promise<ReportRow[]> {
  const p = new Params();
  const day = businessDay(p, 'at', params);
  const sql = `
    WITH movements AS (
      SELECT pm.received_at AS at,
             CASE WHEN pm.kind = 'refund' THEN -pm.amount ELSE pm.amount END AS inflow,
             0::bigint AS outflow, pm.mode
      FROM payments pm
      WHERE pm.status <> 'void' AND ${outletScope(p, 'pm', params)}
        AND ${instantRange(p, 'pm.received_at', params)}
      UNION ALL
      SELECT e.spent_at AS at, 0::bigint AS inflow, e.amount AS outflow, e.mode
      FROM expenses e
      WHERE e.status <> 'void' AND ${outletScope(p, 'e', params)}
        AND ${instantRange(p, 'e.spent_at', params)}
      UNION ALL
      SELECT sp.paid_at AS at, 0::bigint AS inflow, sp.amount AS outflow, sp.mode
      FROM supplier_payments sp
      WHERE sp.status <> 'void' AND ${outletScope(p, 'sp', params)}
        AND ${instantRange(p, 'sp.paid_at', params)}
    )
    SELECT ${day} AS "date",
           SUM(inflow)::bigint AS "moneyIn",
           SUM(outflow)::bigint AS "moneyOut",
           (SUM(inflow) - SUM(outflow))::bigint AS "net",
           SUM(CASE WHEN mode = 'cash' THEN inflow - outflow ELSE 0 END)::bigint AS "cashNet",
           SUM(CASE WHEN mode <> 'cash' THEN inflow - outflow ELSE 0 END)::bigint AS "bankNet"
    FROM movements
    GROUP BY 1
    ORDER BY 1
    LIMIT ${p.add(params.limit)}`;
  return tx.many(sql, p.all);
}
