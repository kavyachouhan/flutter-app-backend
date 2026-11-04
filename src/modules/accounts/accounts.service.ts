/**
 * Cash & Bank — where money physically sits.
 *
 * A balance is never a stored number; it is the sum of every transaction
 * ever written against an account (see 0030_accounts.sql). This module's
 * whole job is to write correct, paired transactions — nothing here ever
 * computes "the new balance" and stores it directly.
 *
 * Phase 1: the accounts themselves and manual money movement (add/reduce
 * cash, transfer between accounts). Billing, expenses and supplier payments
 * do not write to this ledger yet — that is separate, later work.
 */
import { randomUUID } from 'node:crypto';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import {
  accountsRepository,
  type AccountRow,
  type DocumentSourceType,
  type TransactionRow,
  type TransactionType,
} from './accounts.repository.js';
import type {
  AdjustCashBody,
  CreateBankAccountBody,
  ListTransactionsQuery,
  TransferBody,
  UpdateAccountBody,
} from './accounts.schemas.js';

/**
 * Every tenant has exactly one Cash In-Hand account, with no setup step —
 * created the first time anything asks for it, the same way a numbering
 * series provisions itself on first use.
 */
export async function ensureDefaultCashAccount(tx: Tx): Promise<AccountRow> {
  const existing = await accountsRepository.findDefaultCash(tx);
  if (existing) return existing;

  const auth = requireAuthContext();
  await accountsRepository.insert(tx, {
    id: randomUUID(),
    type: 'cash',
    name: 'Cash In-Hand',
    bankName: null,
    accountNumber: null,
    ifsc: null,
    isDefaultCash: true,
    createdBy: auth.userId,
  });
  const created = await accountsRepository.findDefaultCash(tx);
  if (!created) throw new Error('cash account insert returned no row');
  return created;
}

export function listAccounts(includeInactive = false) {
  // Not read-only: the first call for a tenant has to create Cash In-Hand.
  return withTransaction(async (tx) => {
    await ensureDefaultCashAccount(tx);
    return accountsRepository.list(tx, includeInactive);
  });
}

export function getAccount(id: string) {
  return withReadTransaction(async (tx) => {
    const account = await accountsRepository.find(tx, id);
    if (!account) throw new NotFoundError('Account');
    return account;
  });
}

export function createBankAccount(body: CreateBankAccountBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    await accountsRepository.insert(tx, {
      id: body.id,
      type: 'bank',
      name: body.name,
      bankName: body.bankName ?? null,
      accountNumber: body.accountNumber ?? null,
      ifsc: body.ifsc ?? null,
      isDefaultCash: false,
      createdBy: auth.userId,
    });

    if (body.openingBalance) {
      await accountsRepository.insertTransaction(tx, {
        id: randomUUID(),
        accountId: body.id,
        amount: body.openingBalance,
        transactionType: 'opening',
        transferAccountId: null,
        chequeNumber: null,
        chequeDate: null,
        note: null,
        occurredAt: body.openingDate ?? new Date().toISOString(),
        createdBy: auth.userId,
      });
    }

    const created = await accountsRepository.find(tx, body.id);
    if (!created) throw new Error('account insert returned no row');
    return created;
  });
}

export function updateAccount(id: string, body: UpdateAccountBody) {
  return withTransaction(async (tx) => {
    const account = await accountsRepository.find(tx, id);
    if (!account) throw new NotFoundError('Account');
    if (account.isDefaultCash && body.isActive === false) {
      throw new UnprocessableError('Cash In-Hand cannot be deactivated.');
    }
    await accountsRepository.update(tx, id, body);
    const updated = await accountsRepository.find(tx, id);
    if (!updated) throw new Error('account update returned no row');
    return updated;
  });
}

export function listTransactions(accountId: string, query: ListTransactionsQuery) {
  return withReadTransaction(async (tx) => {
    if (!(await accountsRepository.find(tx, accountId))) throw new NotFoundError('Account');
    const page = parsePage(query);
    const rows = await accountsRepository.listTransactions(tx, accountId, page.limit, page.cursor);
    return buildPage(rows, page.limit, (row: TransactionRow) => ({
      k: row.occurredAt.toISOString(),
      id: row.id,
    }));
  });
}

export function listCheques(query: ListTransactionsQuery) {
  return withReadTransaction(async (tx) => {
    const page = parsePage(query);
    const rows = await accountsRepository.listCheques(tx, page.limit, page.cursor);
    return buildPage(rows, page.limit, (row: TransactionRow) => ({
      k: row.occurredAt.toISOString(),
      id: row.id,
    }));
  });
}

/** Add Cash (positive amount) or Reduce Cash (negative amount). */
export function adjustCash(body: AdjustCashBody) {
  const auth = requireAuthContext();
  return withTransaction(async (tx) => {
    const cash = await ensureDefaultCashAccount(tx);
    // Same id twice (a retried request after a dropped reply) changes
    // nothing instead of adjusting the cash balance twice — returning the
    // account fresh, not the pre-check snapshot, so a replay still shows
    // the balance the first, successful call actually produced.
    if (await accountsRepository.transactionExists(tx, body.id)) {
      return (await accountsRepository.find(tx, cash.id))!;
    }
    await accountsRepository.insertTransaction(tx, {
      id: body.id,
      accountId: cash.id,
      amount: body.amount,
      transactionType: 'manual_adjustment',
      transferAccountId: null,
      chequeNumber: null,
      chequeDate: null,
      note: body.note ?? null,
      occurredAt: body.occurredAt ?? new Date().toISOString(),
      createdBy: auth.userId,
    });
    const updated = await accountsRepository.find(tx, cash.id);
    if (!updated) throw new Error('cash account disappeared mid-transaction');
    return updated;
  });
}

/**
 * Moves money between two accounts as one paired write: a transfer_out on
 * the source and a transfer_in on the destination, same amount, same
 * occurred_at, each pointing at the other via transfer_account_id — both
 * inside the one transaction so a reader never sees just one half.
 */
export function transfer(body: TransferBody) {
  const auth = requireAuthContext();
  if (body.fromAccountId === body.toAccountId) {
    throw new UnprocessableError('Cannot transfer an account to itself.');
  }
  return withTransaction(async (tx) => {
    const [from, to] = await Promise.all([
      accountsRepository.find(tx, body.fromAccountId, true),
      accountsRepository.find(tx, body.toAccountId, true),
    ]);
    if (!from) throw new NotFoundError('Account', { details: { role: 'fromAccountId' } });
    if (!to) throw new NotFoundError('Account', { details: { role: 'toAccountId' } });

    // Same id twice (a retried request after a dropped reply) changes
    // nothing instead of moving the money twice.
    if (await accountsRepository.transactionExists(tx, body.id)) {
      const [fromNow, toNow] = await Promise.all([
        accountsRepository.find(tx, from.id),
        accountsRepository.find(tx, to.id),
      ]);
      return { from: fromNow!, to: toNow! };
    }

    const occurredAt = body.occurredAt ?? new Date().toISOString();
    await accountsRepository.insertTransaction(tx, {
      id: body.id,
      accountId: from.id,
      amount: -body.amount,
      transactionType: 'transfer_out',
      transferAccountId: to.id,
      chequeNumber: null,
      chequeDate: null,
      note: body.note ?? null,
      occurredAt,
      createdBy: auth.userId,
    });
    await accountsRepository.insertTransaction(tx, {
      id: randomUUID(),
      accountId: to.id,
      amount: body.amount,
      transactionType: 'transfer_in',
      transferAccountId: from.id,
      chequeNumber: null,
      chequeDate: null,
      note: body.note ?? null,
      occurredAt,
      createdBy: auth.userId,
    });

    const [fromAfter, toAfter] = await Promise.all([
      accountsRepository.find(tx, from.id),
      accountsRepository.find(tx, to.id),
    ]);
    return { from: fromAfter!, to: toAfter! };
  });
}

/**
 * Where a sale, a khata receipt, an expense or a supplier payment actually
 * moves the money — called from inside those modules' own transactions, not
 * through a route of its own. `accountId` null means cash (mode 'cash' has
 * nowhere else to go: there is only ever one Cash In-Hand account).
 *
 * Idempotent on (sourceType, sourceId, transactionType): a replayed create
 * finds its own row already there and writes nothing a second time, backed
 * by the unique index in 0031, not just this check — a crash between the
 * check and the insert still cannot double-write.
 */
export interface DocumentMoneyMovement {
  accountId: string | null;
  /** Paise, signed: positive for money in, negative for money out. */
  amount: number;
  transactionType: 'sale' | 'receipt' | 'expense' | 'supplier_payment';
  sourceType: DocumentSourceType;
  sourceId: string;
  chequeNumber?: string | null;
  chequeDate?: string | null;
  note?: string | null;
  occurredAt: string;
}

export async function recordDocumentMoney(tx: Tx, m: DocumentMoneyMovement): Promise<void> {
  if (await accountsRepository.findBySource(tx, m.sourceType, m.sourceId, m.transactionType)) {
    return;
  }
  const auth = requireAuthContext();
  const accountId = m.accountId ?? (await ensureDefaultCashAccount(tx)).id;
  await accountsRepository.insertTransaction(tx, {
    id: randomUUID(),
    accountId,
    amount: m.amount,
    transactionType: m.transactionType,
    transferAccountId: null,
    chequeNumber: m.chequeNumber ?? null,
    chequeDate: m.chequeDate ?? null,
    note: m.note ?? null,
    occurredAt: m.occurredAt,
    createdBy: auth.userId,
    sourceType: m.sourceType,
    sourceId: m.sourceId,
  });
}

/**
 * Reverses whatever {@link recordDocumentMoney} wrote for this document, with
 * an opposite-signed 'void' row — never by touching the original. A no-op
 * when nothing was ever recorded for it (an older document, or one that was
 * khata-only and never moved real money) or it was already reversed.
 */
export async function voidDocumentMoney(
  tx: Tx,
  sourceType: DocumentSourceType,
  sourceId: string,
  forwardTransactionType: Exclude<TransactionType, 'void'>,
): Promise<void> {
  if (await accountsRepository.findBySource(tx, sourceType, sourceId, 'void')) return;
  const original = await accountsRepository.findBySource(
    tx,
    sourceType,
    sourceId,
    forwardTransactionType,
  );
  if (!original) return;
  const auth = requireAuthContext();
  await accountsRepository.insertTransaction(tx, {
    id: randomUUID(),
    accountId: original.accountId,
    amount: -original.amount,
    transactionType: 'void',
    transferAccountId: null,
    chequeNumber: null,
    chequeDate: null,
    note: null,
    occurredAt: new Date().toISOString(),
    createdBy: auth.userId,
    sourceType,
    sourceId,
  });
}
