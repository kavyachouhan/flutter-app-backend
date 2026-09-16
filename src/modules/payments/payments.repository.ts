import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export interface PaymentRow {
  id: string;
  outletId: string;
  customerId: string | null;
  kind: 'invoice_tender' | 'receipt';
  mode: string;
  amount: number;
  tenderedAmount: number | null;
  reference: string | null;
  receivedAt: Date;
  receivedBy: string;
  status: 'issued' | 'void';
  voidReason: string | null;
  voidedAt: Date | null;
  createdAt: Date;
}

export interface TenderInput {
  id: string;
  mode: string;
  amount: number;
  tenderedAmount?: number | undefined;
  reference?: string | undefined;
}

export interface AllocationInput {
  paymentId: string;
  invoiceId: string;
  amount: number;
}

const PAYMENT_COLUMNS = `
  id, outlet_id AS "outletId", customer_id AS "customerId", kind, mode, amount, tendered_amount AS "tenderedAmount",
  reference, received_at AS "receivedAt", received_by AS "receivedBy", status, void_reason AS "voidReason",
  voided_at AS "voidedAt", created_at AS "createdAt"`;

export const paymentsRepository = {
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM payments WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  find(tx: Tx, id: string, forUpdate = false): Promise<PaymentRow | undefined> {
    return tx.one<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
  },

  list(
    tx: Tx,
    customerId: string | undefined,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<PaymentRow[]> {
    return tx.many<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments
       WHERE ($1::uuid IS NULL OR customer_id = $1)
         AND ($2::timestamptz IS NULL OR (received_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY received_at DESC, id DESC
       LIMIT $4`,
      [customerId ?? null, cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },

  findAllocations(tx: Tx, paymentId: string) {
    return tx.many<{ invoiceId: string; documentNumber: string; amount: number }>(
      `SELECT pa.invoice_id AS "invoiceId", i.document_number AS "documentNumber", pa.amount
       FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
       WHERE pa.payment_id = $1 ORDER BY i.document_date, i.id`,
      [paymentId],
    );
  },

  findForInvoice(tx: Tx, invoiceId: string) {
    return tx.many(
      `SELECT p.id, p.kind, p.mode, pa.amount, p.tendered_amount AS "tenderedAmount", p.reference,
              p.received_at AS "receivedAt", p.status
       FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
       WHERE pa.invoice_id = $1 ORDER BY p.received_at, p.id`,
      [invoiceId],
    );
  },

  async insertReceipt(
    tx: Tx,
    p: {
      id: string;
      outletId: string;
      customerId: string;
      mode: string;
      amount: number;
      reference: string | null;
      receivedAt: string;
      receivedBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO payments (id, tenant_id, outlet_id, customer_id, kind, mode, amount, reference, received_at, received_by, status)
       VALUES ($1, app.current_tenant_id(), $2, $3, 'receipt', $4, $5, $6, $7, $8, 'issued')`,
      [p.id, p.outletId, p.customerId, p.mode, p.amount, p.reference, p.receivedAt, p.receivedBy],
    );
  },

  async insertTenders(
    tx: Tx,
    input: {
      outletId: string;
      customerId: string | null;
      receivedAt: string;
      receivedBy: string;
      tenders: readonly TenderInput[];
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO payments (id, tenant_id, outlet_id, customer_id, kind, mode, amount, tendered_amount, reference,
         received_at, received_by, status)
       SELECT t.id, app.current_tenant_id(), $1, $2, 'invoice_tender', t.mode, t.amount, t."tenderedAmount", t.reference,
              $3, $4, 'issued'
       FROM jsonb_to_recordset($5::jsonb) AS t(id uuid, mode text, amount bigint, "tenderedAmount" bigint, reference text)`,
      [
        input.outletId,
        input.customerId,
        input.receivedAt,
        input.receivedBy,
        JSON.stringify(input.tenders),
      ],
    );
  },

  async insertAllocations(tx: Tx, allocations: readonly AllocationInput[]): Promise<void> {
    if (allocations.length === 0) return;
    await tx.query(
      `INSERT INTO payment_allocations (id, tenant_id, payment_id, invoice_id, amount)
       SELECT gen_random_uuid(), app.current_tenant_id(), a."paymentId", a."invoiceId", a.amount
       FROM jsonb_to_recordset($1::jsonb) AS a("paymentId" uuid, "invoiceId" uuid, amount bigint)`,
      [JSON.stringify(allocations)],
    );
  },

  /** Locked in id order so two receipts touching the same invoices cannot deadlock. */
  lockInvoices(tx: Tx, invoiceIds: readonly string[]) {
    return tx.many<{ id: string; customerId: string | null; status: string }>(
      `SELECT id, customer_id AS "customerId", status FROM invoices
       WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[...invoiceIds]],
    );
  },

  async outstandingByInvoice(tx: Tx, invoiceIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await tx.many<{ id: string; outstanding: number }>(
      `SELECT i.id, i.grand_total - COALESCE(SUM(pa.amount) FILTER (WHERE p.status = 'issued'), 0) AS outstanding
       FROM invoices i
       LEFT JOIN payment_allocations pa ON pa.invoice_id = i.id
       LEFT JOIN payments p ON p.id = pa.payment_id
       WHERE i.id = ANY($1::uuid[])
       GROUP BY i.id`,
      [[...invoiceIds]],
    );
    return new Map(rows.map((row) => [row.id, row.outstanding]));
  },

  async hasActiveReceiptAllocations(tx: Tx, invoiceId: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
         WHERE pa.invoice_id = $1 AND p.kind = 'receipt' AND p.status = 'issued') AS found`,
      [invoiceId],
    );
    return row?.found ?? false;
  },

  voidTendersForInvoice(tx: Tx, invoiceId: string, reason: string, userId: string) {
    return tx.many<{ id: string; amount: number }>(
      `UPDATE payments p SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3
       FROM payment_allocations pa
       WHERE pa.payment_id = p.id AND pa.invoice_id = $1 AND p.kind = 'invoice_tender' AND p.status = 'issued'
       RETURNING p.id, p.amount`,
      [invoiceId, reason, userId],
    );
  },

  async markVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      "UPDATE payments SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3 WHERE id = $1",
      [id, reason, userId],
    );
  },
};
