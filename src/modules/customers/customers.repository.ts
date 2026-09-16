import type { Tx } from '../../db/tx.js';
import { buildSet, likeContains } from '../../db/sql.js';
import type { Cursor } from '../../lib/pagination.js';

export interface CustomerRow {
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
  creditLimit: number | null;
  notes: string | null;
  /** Paise the customer owes; negative is an advance. */
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewCustomer = Omit<CustomerRow, 'balance' | 'createdAt' | 'updatedAt'>;

export type LedgerEntryType =
  'opening_balance' | 'invoice' | 'invoice_void' | 'payment' | 'payment_void';

export interface NewLedgerEntry {
  customerId: string;
  entryType: LedgerEntryType;
  debit: number;
  credit: number;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: string;
  note: string | null;
  createdBy: string;
}

export interface LedgerEntryRow {
  id: string;
  entryType: LedgerEntryType;
  debit: number;
  credit: number;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: Date;
  note: string | null;
  runningBalance: number;
}

const CUSTOMER_COLUMNS = `
  c.id, c.name, c.phone, c.email, c.gstin, c.state_code AS "stateCode", c.address_line1 AS "addressLine1",
  c.address_line2 AS "addressLine2", c.city, c.pincode, c.credit_limit AS "creditLimit", c.notes,
  COALESCE(b.balance, 0) AS balance, c.created_at AS "createdAt", c.updated_at AS "updatedAt"`;

const FROM = 'FROM customers c LEFT JOIN customer_balances b ON b.customer_id = c.id';

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
  creditLimit: 'credit_limit',
  notes: 'notes',
} as const;

export const customersRepository = {
  list(
    tx: Tx,
    q: string | undefined,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<CustomerRow[]> {
    return tx.many<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS} ${FROM}
       WHERE c.deleted_at IS NULL
         AND ($1::text IS NULL OR c.name ILIKE $1 OR c.phone LIKE $2)
         AND ($3::text IS NULL OR (c.name, c.id) > ($3::text, $4::uuid))
       ORDER BY c.name, c.id
       LIMIT $5`,
      [
        q ? likeContains(q) : null,
        q ? likeContains(q.replace(/\D/g, '') || q) : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  find(tx: Tx, id: string, forUpdate = false): Promise<CustomerRow | undefined> {
    return tx.one<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS} ${FROM} WHERE c.id = $1 AND c.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF c' : ''}`,
      [id],
    );
  },

  async insert(tx: Tx, c: NewCustomer): Promise<void> {
    await tx.query(
      `INSERT INTO customers (id, tenant_id, name, phone, email, gstin, state_code, address_line1, address_line2,
         city, pincode, credit_limit, notes)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        c.id,
        c.name,
        c.phone,
        c.email,
        c.gstin,
        c.stateCode,
        c.addressLine1,
        c.addressLine2,
        c.city,
        c.pincode,
        c.creditLimit,
        c.notes,
      ],
    );
  },

  async update(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE customers SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE customers SET deleted_at = now() WHERE id = $1', [id]);
  },

  async insertLedgerEntries(tx: Tx, entries: readonly NewLedgerEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await tx.query(
      `INSERT INTO customer_ledger_entries (id, tenant_id, customer_id, entry_type, debit, credit, reference_type,
         reference_id, occurred_at, note, created_by)
       SELECT gen_random_uuid(), app.current_tenant_id(), e."customerId", e."entryType", e.debit, e.credit,
              e."referenceType", e."referenceId", e."occurredAt", e.note, e."createdBy"
       FROM jsonb_to_recordset($1::jsonb) AS e(
         "customerId" uuid, "entryType" text, debit bigint, credit bigint, "referenceType" text,
         "referenceId" uuid, "occurredAt" timestamptz, note text, "createdBy" uuid)`,
      [JSON.stringify(entries)],
    );
  },

  /** Running balance is computed over the full history, then paginated. */
  statement(
    tx: Tx,
    customerId: string,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<LedgerEntryRow[]> {
    return tx.many<LedgerEntryRow>(
      `SELECT * FROM (
         SELECT e.id, e.entry_type AS "entryType", e.debit, e.credit, e.reference_type AS "referenceType",
                e.reference_id AS "referenceId", e.occurred_at AS "occurredAt", e.note,
                SUM(e.debit - e.credit) OVER (ORDER BY e.occurred_at, e.id) AS "runningBalance"
         FROM customer_ledger_entries e WHERE e.customer_id = $1
       ) s
       WHERE ($2::timestamptz IS NULL OR (s."occurredAt", s.id) > ($2::timestamptz, $3::uuid))
       ORDER BY s."occurredAt", s.id
       LIMIT $4`,
      [customerId, cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },
};
