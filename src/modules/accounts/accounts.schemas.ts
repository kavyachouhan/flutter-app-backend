import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { bankAccountNumber, ifsc, nonEmpty, paise, timestamp } from '../../lib/validators.js';

export const createBankAccountBody = z.object({
  id: clientId,
  name: nonEmpty,
  bankName: nonEmpty.optional(),
  accountNumber: bankAccountNumber.optional(),
  ifsc: ifsc.optional(),
  /** The balance this account already held before it was added here. */
  openingBalance: paise.optional(),
  openingDate: timestamp.optional(),
});
export type CreateBankAccountBody = z.infer<typeof createBankAccountBody>;

export const updateAccountBody = z.object({
  name: nonEmpty.optional(),
  bankName: nonEmpty.nullable().optional(),
  accountNumber: bankAccountNumber.nullable().optional(),
  ifsc: ifsc.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateAccountBody = z.infer<typeof updateAccountBody>;

/** Add Cash or Reduce Cash, against the business's one built-in cash account. */
export const adjustCashBody = z.object({
  id: clientId,
  /** Positive to add, negative to reduce — the sign the ledger itself stores. */
  amount: z.number().int().refine((v) => v !== 0, 'cannot be zero'),
  note: nonEmpty.max(200).optional(),
  occurredAt: timestamp.optional(),
});
export type AdjustCashBody = z.infer<typeof adjustCashBody>;

/** Bank Transfer: cash to a bank, a bank to cash, or bank to bank. */
export const transferBody = z.object({
  id: clientId,
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: paise.refine((v) => v > 0, 'must be positive'),
  note: nonEmpty.max(200).optional(),
  occurredAt: timestamp.optional(),
});
export type TransferBody = z.infer<typeof transferBody>;

export const listTransactionsQuery = pageQuery;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuery>;

export const listChequesQuery = pageQuery;
export type ListChequesQuery = z.infer<typeof listChequesQuery>;
