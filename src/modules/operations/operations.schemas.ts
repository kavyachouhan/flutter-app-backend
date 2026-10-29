import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import {
  isoDate,
  nonEmpty,
  paise,
  positivePaise,
  requireAccountForNonCashMode,
  timestamp,
} from '../../lib/validators.js';
import { TENDER_MODES } from '../invoices/invoices.schemas.js';

// --- Held bills -------------------------------------------------------------

export const upsertHeldBillBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  counterId: z.string().uuid().nullable().optional(),
  label: nonEmpty.optional(),
  customerId: z.string().uuid().nullable().optional(),
  customerName: nonEmpty.optional(),
  lineCount: z.number().int().nonnegative(),
  estimatedTotal: paise,
  /**
   * The device's draft, stored verbatim. The server does not interpret it:
   * a parked bill is not a document, and two implementations of the same
   * draft would eventually disagree.
   */
  payload: z.record(z.unknown()),
  heldAt: timestamp,
});
export type UpsertHeldBillBody = z.infer<typeof upsertHeldBillBody>;

export const releaseHeldBillBody = z.object({
  /** `billed` when it became an invoice, `discarded` when the customer left. */
  outcome: z.enum(['billed', 'discarded']),
  invoiceId: z.string().uuid().optional(),
});
export type ReleaseHeldBillBody = z.infer<typeof releaseHeldBillBody>;

export const listHeldBillsQuery = z.object({
  outletId: z.string().uuid().optional(),
  counterId: z.string().uuid().optional(),
  includeReleased: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListHeldBillsQuery = z.infer<typeof listHeldBillsQuery>;

// --- Expense categories -----------------------------------------------------

export const createExpenseCategoryBody = z.object({
  id: clientId,
  name: nonEmpty,
  /** Direct costs sit above the gross-margin line in the daily P&L. */
  isDirect: z.boolean().optional(),
});
export type CreateExpenseCategoryBody = z.infer<typeof createExpenseCategoryBody>;

export const updateExpenseCategoryBody = z.object({
  name: nonEmpty.optional(),
  isDirect: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateExpenseCategoryBody = z.infer<typeof updateExpenseCategoryBody>;

// --- Expenses ---------------------------------------------------------------

export const createExpenseBody = z
  .object({
    id: clientId,
    outletId: z.string().uuid(),
    categoryId: z.string().uuid().nullable().optional(),
    amount: positivePaise,
    mode: z.enum(TENDER_MODES),
    vendorName: nonEmpty.optional(),
    reference: nonEmpty.max(100).optional(),
    note: nonEmpty.optional(),
    /** Storage object key from `POST /uploads`, never a URL: URLs expire. */
    receiptObjectKey: nonEmpty.optional(),
    spentAt: timestamp,
    /** Which Cash & Bank account this was paid from; required unless mode is 'cash'. */
    accountId: z.string().uuid().optional(),
  })
  .superRefine(requireAccountForNonCashMode);
export type CreateExpenseBody = z.infer<typeof createExpenseBody>;

export const voidExpenseBody = z.object({ reason: nonEmpty });

export const listExpensesQuery = pageQuery.extend({
  outletId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  mode: z.enum(TENDER_MODES).optional(),
  status: z.enum(['issued', 'void']).optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
});
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;

// --- Day close --------------------------------------------------------------

export const dayCloseExpectedQuery = z.object({
  outletId: z.string().uuid(),
  counterId: z.string().uuid().optional(),
  businessDate: isoDate.optional(),
});
export type DayCloseExpectedQuery = z.infer<typeof dayCloseExpectedQuery>;

export const createDayCloseBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  counterId: z.string().uuid().nullable().optional(),
  businessDate: isoDate,
  /** Cash in the drawer at the start; usually the previous close's closing float. */
  openingFloat: paise,
  /** What the cashier counted. */
  countedCash: positivePaise.or(z.literal(0)),
  /** Optional per-mode counts, e.g. a card terminal settlement total. */
  countedByMode: z.record(z.enum(TENDER_MODES), paise).optional(),
  /** Cash left in the drawer for tomorrow. */
  closingFloat: paise,
  note: nonEmpty.optional(),
  closedAt: timestamp,
});
export type CreateDayCloseBody = z.infer<typeof createDayCloseBody>;

export const listDayClosesQuery = pageQuery.extend({
  outletId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ListDayClosesQuery = z.infer<typeof listDayClosesQuery>;
