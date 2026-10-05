import type { Tx } from '../../db/tx.js';
import { buildSet, likeContains } from '../../db/sql.js';
import type { Cursor } from '../../lib/pagination.js';

export interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  paymentTermsDays: number | null;
  leadTimeDays: number | null;
  notes: string | null;
  isActive: boolean;
  /** Paise the shop owes this supplier; negative is an advance paid. */
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewSupplier = Omit<SupplierRow, 'balance' | 'createdAt' | 'updatedAt'>;

export type SupplierLedgerEntryType =
  | 'opening_balance'
  | 'purchase'
  | 'purchase_void'
  | 'payment'
  | 'payment_void'
  | 'debit_note'
  | 'debit_note_void';

/**
 * Credit increases what the shop owes; debit reduces it. The mirror of the
 * customer ledger, and the single easiest thing in this module to get
 * backwards.
 */
export interface NewSupplierLedgerEntry {
  supplierId: string;
  entryType: SupplierLedgerEntryType;
  debit: number;
  credit: number;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: string;
  note: string | null;
  createdBy: string;
}

export interface SupplierLedgerEntryRow {
  id: string;
  entryType: SupplierLedgerEntryType;
  debit: number;
  credit: number;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: Date;
  note: string | null;
  runningBalance: number;
}

export interface AgeingBucketRow {
  bucket: string;
  amount: number;
  billCount: number;
}

const SUPPLIER_COLUMNS = `
  s.id, s.name, s.phone, s.email, s.gstin, s.state_code AS "stateCode",
  s.address_line1 AS "addressLine1", s.address_line2 AS "addressLine2", s.city, s.pincode,
  s.payment_terms_days AS "paymentTermsDays", s.lead_time_days AS "leadTimeDays", s.notes,
  s.is_active AS "isActive", COALESCE(b.balance, 0) AS balance,
  s.created_at AS "createdAt", s.updated_at AS "updatedAt"`;

const FROM = 'FROM suppliers s LEFT JOIN supplier_balances b ON b.supplier_id = s.id';

const UPDATABLE = {
  name: 'name',
  phone: 'phone',
  email: 'email',
  gstin: 'gstin',
  stateCode: 'state_code',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  pincode: 'pincode',
  paymentTermsDays: 'payment_terms_days',
  leadTimeDays: 'lead_time_days',
  notes: 'notes',
  isActive: 'is_active',
} as const;

/**
 * What is still owed on a bill: its total, less issued payments allocated to
 * it, less issued debit notes raised against it. Used by the ageing report
 * and by payment allocation, so it is defined once.
 */
const OUTSTANDING = `
  pb.grand_total
  - COALESCE((SELECT SUM(a.amount) FROM supplier_payment_allocations a
              JOIN supplier_payments p ON p.id = a.supplier_payment_id
              WHERE a.purchase_bill_id = pb.id AND p.status = 'issued'), 0)
  - COALESCE((SELECT SUM(d.grand_total) FROM debit_notes d
              WHERE d.purchase_bill_id = pb.id AND d.status = 'issued'), 0)`;

export const suppliersRepository = {
  list(
    tx: Tx,
    q: string | undefined,
    includeInactive: boolean,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<SupplierRow[]> {
    return tx.many<SupplierRow>(
      `SELECT ${SUPPLIER_COLUMNS} ${FROM}
       WHERE s.deleted_at IS NULL
         AND ($1::boolean OR s.is_active)
         AND ($2::text IS NULL OR s.name ILIKE $2 OR s.phone LIKE $3)
         AND ($4::text IS NULL OR (s.name, s.id) > ($4::text, $5::uuid))
       ORDER BY s.name, s.id
       LIMIT $6`,
      [
        includeInactive,
        q ? likeContains(q) : null,
        q ? likeContains(q.replace(/\D/g, '') || q) : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  find(tx: Tx, id: string, forUpdate = false): Promise<SupplierRow | undefined> {
    return tx.one<SupplierRow>(
      `SELECT ${SUPPLIER_COLUMNS} ${FROM}
       WHERE s.id = $1 AND s.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF s' : ''}`,
      [id],
    );
  },

  async insert(tx: Tx, s: NewSupplier): Promise<void> {
    await tx.query(
      `INSERT INTO suppliers (id, tenant_id, name, phone, email, gstin, state_code, address_line1,
         address_line2, city, pincode, payment_terms_days, lead_time_days, notes, is_active)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        s.id,
        s.name,
        s.phone,
        s.email,
        s.gstin,
        s.stateCode,
        s.addressLine1,
        s.addressLine2,
        s.city,
        s.pincode,
        s.paymentTermsDays,
        s.leadTimeDays,
        s.notes,
        s.isActive,
      ],
    );
  },

  async update(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE suppliers SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE suppliers SET deleted_at = now(), is_active = false WHERE id = $1', [
      id,
    ]);
  },

  async insertLedgerEntries(tx: Tx, entries: readonly NewSupplierLedgerEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await tx.query(
      `INSERT INTO supplier_ledger_entries (id, tenant_id, supplier_id, entry_type, debit, credit,
         reference_type, reference_id, occurred_at, note, created_by)
       SELECT gen_random_uuid(), app.current_tenant_id(), e."supplierId", e."entryType", e.debit, e.credit,
              e."referenceType", e."referenceId", e."occurredAt", e.note, e."createdBy"
       FROM jsonb_to_recordset($1::jsonb) AS e(
         "supplierId" uuid, "entryType" text, debit bigint, credit bigint, "referenceType" text,
         "referenceId" uuid, "occurredAt" timestamptz, note text, "createdBy" uuid)`,
      [JSON.stringify(entries)],
    );
  },

  /** Running balance over the whole history, then paginated. */
  statement(
    tx: Tx,
    supplierId: string,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<SupplierLedgerEntryRow[]> {
    return tx.many<SupplierLedgerEntryRow>(
      `SELECT * FROM (
         SELECT e.id, e.entry_type AS "entryType", e.debit, e.credit,
                e.reference_type AS "referenceType", e.reference_id AS "referenceId",
                e.occurred_at AS "occurredAt", e.note,
                SUM(e.credit - e.debit) OVER (ORDER BY e.occurred_at, e.id) AS "runningBalance"
         FROM supplier_ledger_entries e WHERE e.supplier_id = $1
       ) s
       WHERE ($2::timestamptz IS NULL OR (s."occurredAt", s.id) > ($2::timestamptz, $3::uuid))
       ORDER BY s."occurredAt", s.id
       LIMIT $4`,
      [supplierId, cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },

  /**
   * Payables ageing, bucketed from the due date where the supplier has
   * payment terms and from the bill date otherwise.
   *
   * Age is measured against the shop's own calendar day, not the server's:
   * a bill is 31 days old when the shopkeeper's date says so.
   */
  ageing(
    tx: Tx,
    supplierId: string | undefined,
    timezone: string,
  ): Promise<(AgeingBucketRow & { supplierId: string; supplierName: string })[]> {
    return tx.many(
      `WITH open_bills AS (
         SELECT pb.id, pb.supplier_id, pb.document_date,
                COALESCE(pb.due_date, pb.document_date) AS reference_date,
                ${OUTSTANDING} AS outstanding
         FROM purchase_bills pb
         WHERE pb.status = 'issued'
           AND ($1::uuid IS NULL OR pb.supplier_id = $1)
       )
       SELECT o.supplier_id AS "supplierId", s.name AS "supplierName",
              CASE
                WHEN (CURRENT_DATE AT TIME ZONE $2)::date - o.reference_date <= 30 THEN '0-30'
                WHEN (CURRENT_DATE AT TIME ZONE $2)::date - o.reference_date <= 60 THEN '31-60'
                WHEN (CURRENT_DATE AT TIME ZONE $2)::date - o.reference_date <= 90 THEN '61-90'
                ELSE '90+'
              END AS bucket,
              SUM(o.outstanding)::bigint AS amount,
              count(*)::int AS "billCount"
       FROM open_bills o
       JOIN suppliers s ON s.id = o.supplier_id
       WHERE o.outstanding > 0
       GROUP BY o.supplier_id, s.name, bucket
       ORDER BY s.name, bucket`,
      [supplierId ?? null, timezone],
    );
  },

  /** Issued bills with money still owed, oldest first — the order to pay them in. */
  outstandingBills(tx: Tx, supplierId: string) {
    return tx.many<{
      id: string;
      documentNumber: string;
      supplierInvoiceNo: string;
      documentDate: string;
      dueDate: string | null;
      grandTotal: number;
      outstanding: number;
    }>(
      `SELECT pb.id, pb.document_number AS "documentNumber",
              pb.supplier_invoice_no AS "supplierInvoiceNo", pb.document_date AS "documentDate",
              pb.due_date AS "dueDate", pb.grand_total AS "grandTotal",
              ${OUTSTANDING} AS outstanding
       FROM purchase_bills pb
       WHERE pb.supplier_id = $1 AND pb.status = 'issued'
       ORDER BY pb.document_date, pb.id`,
      [supplierId],
    );
  },
};
