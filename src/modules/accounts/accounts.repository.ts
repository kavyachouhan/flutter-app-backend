import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export interface AccountRow {
  id: string;
  type: 'cash' | 'bank';
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  isDefaultCash: boolean;
  isActive: boolean;
  /** Paise. The sum of every transaction ever written against this account. */
  balance: number;
}

export interface NewAccount {
  id: string;
  type: 'cash' | 'bank';
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  isDefaultCash: boolean;
  createdBy: string;
}

export type TransactionType =
  | 'opening'
  | 'manual_adjustment'
  | 'transfer_in'
  | 'transfer_out'
  | 'sale'
  | 'receipt'
  | 'expense'
  | 'supplier_payment'
  | 'void';

/** Which kind of document wrote this row — null for one entered directly on a Cash & Bank screen. */
export type DocumentSourceType = 'invoice_payment' | 'receipt' | 'expense' | 'supplier_payment';

export interface NewTransaction {
  id: string;
  accountId: string;
  amount: number;
  transactionType: TransactionType;
  transferAccountId: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  note: string | null;
  occurredAt: string;
  createdBy: string;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
}

export interface TransactionRow {
  id: string;
  accountId: string;
  amount: number;
  transactionType: TransactionType;
  transferAccountId: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  note: string | null;
  occurredAt: Date;
  createdAt: Date;
}

const ACCOUNT_COLUMNS = `
  a.id, a.type, a.name, a.bank_name AS "bankName", a.account_number AS "accountNumber",
  a.ifsc, a.is_default_cash AS "isDefaultCash", a.is_active AS "isActive",
  COALESCE(t.balance, 0)::bigint AS balance`;

const TRANSACTION_COLUMNS = `
  id, account_id AS "accountId", amount, transaction_type AS "transactionType",
  transfer_account_id AS "transferAccountId", cheque_number AS "chequeNumber",
  cheque_date AS "chequeDate", note, occurred_at AS "occurredAt", created_at AS "createdAt"`;

const CHEQUE_COLUMNS = `
  ct.id, ct.account_id AS "accountId", ct.amount, ct.transaction_type AS "transactionType",
  ct.transfer_account_id AS "transferAccountId", ct.cheque_number AS "chequeNumber",
  ct.cheque_date AS "chequeDate", ct.note, ct.occurred_at AS "occurredAt", ct.created_at AS "createdAt",
  a.name AS "accountName"`;

export const accountsRepository = {
  async transactionExists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM account_transactions WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  findDefaultCash(tx: Tx): Promise<AccountRow | undefined> {
    return tx.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts a
       LEFT JOIN (SELECT account_id, SUM(amount) AS balance FROM account_transactions GROUP BY account_id) t
         ON t.account_id = a.id
       WHERE a.is_default_cash`,
    );
  },

  find(tx: Tx, id: string, forUpdate = false): Promise<AccountRow | undefined> {
    return tx.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts a
       LEFT JOIN (SELECT account_id, SUM(amount) AS balance FROM account_transactions GROUP BY account_id) t
         ON t.account_id = a.id
       WHERE a.id = $1 ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
      [id],
    );
  },

  list(tx: Tx, includeInactive: boolean): Promise<AccountRow[]> {
    return tx.many<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts a
       LEFT JOIN (SELECT account_id, SUM(amount) AS balance FROM account_transactions GROUP BY account_id) t
         ON t.account_id = a.id
       WHERE ($1::boolean OR a.is_active)
       ORDER BY a.is_default_cash DESC, a.name`,
      [includeInactive],
    );
  },

  async insert(tx: Tx, account: NewAccount): Promise<void> {
    await tx.query(
      `INSERT INTO accounts (id, tenant_id, type, name, bank_name, account_number, ifsc,
         is_default_cash, created_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8)`,
      [
        account.id,
        account.type,
        account.name,
        account.bankName,
        account.accountNumber,
        account.ifsc,
        account.isDefaultCash,
        account.createdBy,
      ],
    );
  },

  async update(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const columns: Record<string, string> = {
      name: 'name',
      bankName: 'bank_name',
      accountNumber: 'account_number',
      ifsc: 'ifsc',
      isActive: 'is_active',
    };
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        values.push(patch[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return;
    await tx.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $1`, values);
  },

  async insertTransaction(tx: Tx, t: NewTransaction): Promise<void> {
    await tx.query(
      `INSERT INTO account_transactions (id, tenant_id, account_id, amount, transaction_type,
         transfer_account_id, cheque_number, cheque_date, note, occurred_at, created_by,
         source_type, source_id)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        t.id,
        t.accountId,
        t.amount,
        t.transactionType,
        t.transferAccountId,
        t.chequeNumber,
        t.chequeDate,
        t.note,
        t.occurredAt,
        t.createdBy,
        t.sourceType ?? null,
        t.sourceId ?? null,
      ],
    );
  },

  /**
   * The one transaction a given document wrote for a given reason — the
   * idempotency check for both a forward write (has this invoice payment
   * already recorded here?) and its void (has it already been reversed?).
   */
  findBySource(
    tx: Tx,
    sourceType: DocumentSourceType,
    sourceId: string,
    transactionType: TransactionType,
  ): Promise<TransactionRow | undefined> {
    return tx.one<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS} FROM account_transactions
       WHERE source_type = $1 AND source_id = $2 AND transaction_type = $3`,
      [sourceType, sourceId, transactionType],
    );
  },

  listTransactions(
    tx: Tx,
    accountId: string,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<TransactionRow[]> {
    return tx.many<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS} FROM account_transactions
       WHERE account_id = $1
         AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY occurred_at DESC, id DESC
       LIMIT $4`,
      [accountId, cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },

  /** Every cheque, on every account, tenant-wide — what the Cheques screen shows. */
  listCheques(
    tx: Tx,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<(TransactionRow & { accountName: string })[]> {
    return tx.many<TransactionRow & { accountName: string }>(
      `SELECT ${CHEQUE_COLUMNS}
       FROM account_transactions ct
       JOIN accounts a ON a.id = ct.account_id
       WHERE ct.cheque_number IS NOT NULL
         AND ($1::timestamptz IS NULL OR (ct.occurred_at, ct.id) < ($1::timestamptz, $2::uuid))
       ORDER BY ct.occurred_at DESC, ct.id DESC
       LIMIT $3`,
      [cursor ? String(cursor.k) : null, cursor?.id ?? null, limit + 1],
    );
  },
};
