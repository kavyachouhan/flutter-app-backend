/**
 * Counter operations: parked bills, expenses and the day's cash-up.
 *
 * The three sit together because the cash-up is where they meet — a day close
 * is only correct if it knows what was tendered, what was refunded and what
 * was paid out of the drawer.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import {
  ConflictError,
  ErrorCode,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  WarningCode,
  type WarningCodeValue,
} from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import {
  operationsRepository,
  type DayCloseRow,
  type ExpenseCategoryRow,
  type HeldBillRow,
} from './operations.repository.js';
import type {
  CreateDayCloseBody,
  CreateExpenseBody,
  CreateExpenseCategoryBody,
  DayCloseExpectedQuery,
  ListDayClosesQuery,
  ListExpensesQuery,
  ListHeldBillsQuery,
  ReleaseHeldBillBody,
  UpdateExpenseCategoryBody,
  UpsertHeldBillBody,
} from './operations.schemas.js';

/** `en-CA` formats as YYYY-MM-DD, which is the calendar-date shape used everywhere. */
function businessDateIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

// --- Held bills -------------------------------------------------------------

export function listHeldBills(query: ListHeldBillsQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  return withReadTransaction((tx) =>
    operationsRepository.listHeldBills(
      tx,
      {
        outletId: query.outletId,
        counterId: query.counterId,
        includeReleased: query.includeReleased ?? false,
      },
      accessibleOutletIds(),
    ),
  );
}

export function getHeldBill(id: string) {
  return withReadTransaction(async (tx) => {
    const bill = await requireHeldBill(tx, id);
    assertOutletAccess(bill.outletId);
    return bill;
  });
}

async function requireHeldBill(tx: Tx, id: string): Promise<HeldBillRow> {
  const bill = await operationsRepository.findHeldBill(tx, id);
  if (!bill) throw new NotFoundError('Held bill');
  return bill;
}

/**
 * Parks a draft, or updates one already parked. Re-parking the same id is the
 * normal case: the cashier keeps adding lines to a bill that is already held.
 */
export function upsertHeldBill(body: UpsertHeldBillBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    const existing = await operationsRepository.findHeldBill(tx, body.id);
    if (existing && existing.status !== 'held') {
      throw new ConflictError(
        'This bill has already been released.',
        ErrorCode.HELD_BILL_ALREADY_RELEASED,
      );
    }

    if (!existing) {
      const open = await operationsRepository.countOpenHeldBills(
        tx,
        body.outletId,
        body.counterId ?? null,
      );
      if (open >= env.HELD_BILL_MAX_PER_COUNTER) {
        throw new UnprocessableError(
          `This counter already has ${env.HELD_BILL_MAX_PER_COUNTER} bills on hold. Release one first.`,
          ErrorCode.HELD_BILL_LIMIT_REACHED,
          { details: { limit: env.HELD_BILL_MAX_PER_COUNTER, open } },
        );
      }
      if (!(await outletsRepository.findOutlet(tx, body.outletId))) {
        throw new NotFoundError('Outlet');
      }
    }

    await operationsRepository.upsertHeldBill(tx, {
      id: body.id,
      outletId: body.outletId,
      counterId: body.counterId ?? null,
      deviceId: auth.deviceId,
      label: body.label ?? null,
      customerId: body.customerId ?? null,
      customerName: body.customerName ?? null,
      lineCount: body.lineCount,
      estimatedTotal: body.estimatedTotal,
      payload: body.payload,
      heldAt: body.heldAt,
      heldBy: auth.userId,
    });
    return requireHeldBill(tx, body.id);
  });
}

/**
 * Takes a bill off hold. Releasing is idempotent: a device that billed a
 * parked draft and lost the response may send this again.
 */
export function releaseHeldBill(id: string, body: ReleaseHeldBillBody) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    const bill = await operationsRepository.findHeldBill(tx, id);
    if (!bill) return { released: false };
    assertOutletAccess(bill.outletId);
    if (bill.status !== 'held') return { released: false };

    await operationsRepository.releaseHeldBill(
      tx,
      id,
      body.outcome === 'billed' ? 'released' : 'discarded',
      body.invoiceId ?? null,
      auth.userId,
    );
    if (body.outcome === 'discarded') {
      // Discarding a bill a customer walked away from is ordinary; discarding
      // a large one repeatedly is a pattern worth being able to see.
      await recordAudit(tx, {
        action: 'held_bill.discarded',
        entityType: 'held_bill',
        entityId: id,
        metadata: { estimatedTotal: bill.estimatedTotal, lineCount: bill.lineCount },
      });
    }
    return { released: true };
  });
}

// --- Expense categories -----------------------------------------------------

export function listExpenseCategories() {
  return withReadTransaction((tx) => operationsRepository.listExpenseCategories(tx));
}

async function requireExpenseCategory(tx: Tx, id: string): Promise<ExpenseCategoryRow> {
  const category = await operationsRepository.findExpenseCategory(tx, id);
  if (!category) throw new NotFoundError('Expense category');
  return category;
}

export function createExpenseCategory(body: CreateExpenseCategoryBody) {
  return withTransaction(async (tx) => {
    const existing = await operationsRepository.findExpenseCategory(tx, body.id);
    if (existing) return existing;
    await operationsRepository.insertExpenseCategory(tx, {
      id: body.id,
      name: body.name,
      isDirect: body.isDirect ?? false,
    });
    return requireExpenseCategory(tx, body.id);
  });
}

export function updateExpenseCategory(id: string, patch: UpdateExpenseCategoryBody) {
  return withTransaction(async (tx) => {
    await requireExpenseCategory(tx, id);
    await operationsRepository.updateExpenseCategory(tx, id, patch);
    return requireExpenseCategory(tx, id);
  });
}

export function deleteExpenseCategory(id: string) {
  return withTransaction(async (tx) => {
    await requireExpenseCategory(tx, id);
    if (await operationsRepository.expenseCategoryInUse(tx, id)) {
      throw new UnprocessableError(
        'Expenses are recorded against this category. Deactivate it instead of deleting it.',
      );
    }
    await operationsRepository.softDeleteExpenseCategory(tx, id);
  });
}

// --- Expenses ---------------------------------------------------------------

export function createExpense(body: CreateExpenseBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);

  return withTransaction(async (tx) => {
    if (await operationsRepository.expenseExists(tx, body.id)) {
      const existing = await operationsRepository.findExpense(tx, body.id);
      if (!existing) throw new NotFoundError('Expense');
      return { expense: existing, replayed: true };
    }

    if (!(await outletsRepository.findOutlet(tx, body.outletId))) {
      throw new NotFoundError('Outlet');
    }
    if (body.categoryId) await requireExpenseCategory(tx, body.categoryId);

    await operationsRepository.insertExpense(tx, {
      id: body.id,
      outletId: body.outletId,
      categoryId: body.categoryId ?? null,
      amount: body.amount,
      mode: body.mode,
      vendorName: body.vendorName ?? null,
      reference: body.reference ?? null,
      note: body.note ?? null,
      receiptObjectKey: body.receiptObjectKey ?? null,
      spentAt: body.spentAt,
      spentBy: auth.userId,
    });
    await recordAudit(tx, {
      action: 'expense.recorded',
      entityType: 'expense',
      entityId: body.id,
      metadata: { amount: body.amount, mode: body.mode, outletId: body.outletId },
    });

    const expense = await operationsRepository.findExpense(tx, body.id);
    if (!expense) throw new NotFoundError('Expense');
    return { expense, replayed: false };
  });
}

export async function listExpenses(query: ListExpensesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    operationsRepository.listExpenses(
      tx,
      {
        outletId: query.outletId,
        categoryId: query.categoryId,
        mode: query.mode,
        status: query.status,
        from: query.from,
        to: query.to,
      },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.spentAt.toISOString(), id: row.id }));
}

export function getExpense(id: string) {
  return withReadTransaction(async (tx) => {
    const expense = await operationsRepository.findExpense(tx, id);
    if (!expense) throw new NotFoundError('Expense');
    assertOutletAccess(expense.outletId);
    return expense;
  });
}

/** Expenses are immutable; a correction is a void and a fresh entry. */
export function voidExpense(id: string, reason: string) {
  const auth = requireAuthContext();

  return withTransaction(async (tx) => {
    const expense = await operationsRepository.findExpense(tx, id, true);
    if (!expense) throw new NotFoundError('Expense');
    assertOutletAccess(expense.outletId);
    if (expense.status === 'void') return expense;

    await operationsRepository.markExpenseVoid(tx, id, reason, auth.userId);
    await recordAudit(tx, {
      action: 'expense.voided',
      entityType: 'expense',
      entityId: id,
      metadata: { reason, amount: expense.amount },
    });
    const updated = await operationsRepository.findExpense(tx, id);
    if (!updated) throw new NotFoundError('Expense');
    return updated;
  });
}

// --- Day close --------------------------------------------------------------

export interface DayCloseExpectation {
  outletId: string;
  counterId: string | null;
  businessDate: string;
  openedAt: string;
  asOf: string;
  openingFloat: number;
  expectedCash: number;
  salesTotal: number;
  invoiceCount: number;
  cashSales: number;
  cashReceipts: number;
  cashRefunds: number;
  cashExpenses: number;
  byMode: Record<string, number>;
  alreadyClosed: boolean;
}

/** The window a close covers: from the previous close, or the day's first activity. */
async function resolveWindow(
  tx: Tx,
  scope: { outletId: string; counterId: string | null; businessDate: string; endAt: string },
  timezone: string,
): Promise<{ openedAt: string; previous: DayCloseRow | undefined }> {
  const bounds = await tx.one<{ start: Date }>(
    `SELECT ($1::date::timestamp AT TIME ZONE $2) AS start`,
    [scope.businessDate, timezone],
  );
  const dayStart = bounds?.start ?? new Date(`${scope.businessDate}T00:00:00Z`);

  const previous = await operationsRepository.findPreviousDayClose(
    tx,
    scope.outletId,
    scope.counterId,
    scope.endAt,
  );
  // A close continues from the previous one even when that was days ago:
  // takings between the two belong to somebody's drawer.
  const openedAt = previous ? previous.closedAt : dayStart;
  return { openedAt: openedAt.toISOString(), previous };
}

export function getDayCloseExpectation(query: DayCloseExpectedQuery): Promise<DayCloseExpectation> {
  assertOutletAccess(query.outletId);

  return withReadTransaction(async (tx) => {
    const settings = await tenantsRepository.getSettings(tx);
    const now = new Date();
    const businessDate = query.businessDate ?? businessDateIn(settings.timezone, now);
    const counterId = query.counterId ?? null;

    const existing = await operationsRepository.findDayClose(
      tx,
      query.outletId,
      counterId,
      businessDate,
    );
    const { openedAt, previous } = await resolveWindow(
      tx,
      { outletId: query.outletId, counterId, businessDate, endAt: now.toISOString() },
      settings.timezone,
    );

    const totals = await operationsRepository.windowTotals(tx, {
      outletId: query.outletId,
      counterId,
      from: openedAt,
      to: now.toISOString(),
    });
    const openingFloat = previous?.closingFloat ?? 0;

    return {
      outletId: query.outletId,
      counterId,
      businessDate,
      openedAt,
      asOf: now.toISOString(),
      openingFloat,
      expectedCash:
        openingFloat +
        totals.cashSales +
        totals.cashReceipts -
        totals.cashRefunds -
        totals.cashExpenses,
      salesTotal: totals.salesTotal,
      invoiceCount: totals.invoiceCount,
      cashSales: totals.cashSales,
      cashReceipts: totals.cashReceipts,
      cashRefunds: totals.cashRefunds,
      cashExpenses: totals.cashExpenses,
      byMode: totals.byMode,
      alreadyClosed: existing !== undefined,
    };
  });
}

export async function createDayClose(body: CreateDayCloseBody) {
  const auth = requireAuthContext();
  assertOutletAccess(body.outletId);
  const counterId = body.counterId ?? null;

  const result = await withTransaction(async (tx) => {
    const existing = await operationsRepository.findDayClose(
      tx,
      body.outletId,
      counterId,
      body.businessDate,
    );
    if (existing) {
      // Replay of the same close is fine; a second, different one is not.
      if (existing.id === body.id) {
        return {
          dayClose: existing,
          warnings: [] as { code: WarningCodeValue; details: Record<string, unknown> }[],
          replayed: true,
        };
      }
      throw new ConflictError(
        `${body.businessDate} has already been closed for this counter.`,
        ErrorCode.DAY_ALREADY_CLOSED,
        { details: { dayCloseId: existing.id, closedAt: existing.closedAt } },
      );
    }

    const settings = await tenantsRepository.getSettings(tx);
    const { openedAt, previous } = await resolveWindow(
      tx,
      { outletId: body.outletId, counterId, businessDate: body.businessDate, endAt: body.closedAt },
      settings.timezone,
    );
    if (previous && previous.closedAt.toISOString() > body.closedAt) {
      throw new ConflictError(
        'A later cash-up already exists for this counter.',
        ErrorCode.DAY_CLOSE_OUT_OF_ORDER,
        { details: { previousClosedAt: previous.closedAt } },
      );
    }
    if (new Date(body.closedAt).toISOString() < openedAt) {
      throw new ValidationError('The close time is before the window it covers.');
    }

    const totals = await operationsRepository.windowTotals(tx, {
      outletId: body.outletId,
      counterId,
      from: openedAt,
      to: body.closedAt,
    });

    const expectedCash =
      body.openingFloat +
      totals.cashSales +
      totals.cashReceipts -
      totals.cashRefunds -
      totals.cashExpenses;
    const cashVariance = body.countedCash - expectedCash;

    // Widened to a string key: the loop below unions it with the modes the
    // window actually saw, which are not known to the enum at compile time.
    const counted = (body.countedByMode ?? {}) as Record<string, number | undefined>;
    const tenderBreakdown: Record<string, { expected: number; counted: number | null }> = {};
    for (const mode of new Set([...Object.keys(totals.byMode), ...Object.keys(counted)])) {
      tenderBreakdown[mode] = {
        expected: totals.byMode[mode] ?? 0,
        counted: mode === 'cash' ? body.countedCash : (counted[mode] ?? null),
      };
    }

    await operationsRepository.insertDayClose(tx, {
      id: body.id,
      outletId: body.outletId,
      counterId,
      businessDate: body.businessDate,
      openedAt,
      closedAt: body.closedAt,
      openingFloat: body.openingFloat,
      expectedCash,
      countedCash: body.countedCash,
      cashVariance,
      tenderBreakdown,
      salesTotal: totals.salesTotal,
      cashSales: totals.cashSales,
      cashReceipts: totals.cashReceipts,
      cashRefunds: totals.cashRefunds,
      cashExpenses: totals.cashExpenses,
      invoiceCount: totals.invoiceCount,
      closingFloat: body.closingFloat,
      note: body.note ?? null,
      closedBy: auth.userId,
    });
    await recordAudit(tx, {
      action: 'day.closed',
      entityType: 'day_close',
      entityId: body.id,
      metadata: {
        outletId: body.outletId,
        counterId,
        businessDate: body.businessDate,
        expectedCash,
        countedCash: body.countedCash,
        cashVariance,
      },
    });

    const warnings: { code: WarningCodeValue; details: Record<string, unknown> }[] = [];
    if (Math.abs(cashVariance) > env.DAY_CLOSE_VARIANCE_WARN_PAISE) {
      warnings.push({
        code: WarningCode.CASH_VARIANCE_EXCEEDED,
        details: { cashVariance, threshold: env.DAY_CLOSE_VARIANCE_WARN_PAISE },
      });
    }

    const dayClose = await operationsRepository.findDayCloseById(tx, body.id);
    if (!dayClose) throw new NotFoundError('Day close');
    return { dayClose, warnings, replayed: false };
  });

  return result;
}

export async function listDayCloses(query: ListDayClosesQuery) {
  if (query.outletId) assertOutletAccess(query.outletId);
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    operationsRepository.listDayCloses(
      tx,
      { outletId: query.outletId, from: query.from, to: query.to },
      accessibleOutletIds(),
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.closedAt.toISOString(), id: row.id }));
}

export function getDayClose(id: string) {
  return withReadTransaction(async (tx) => {
    const dayClose = await operationsRepository.findDayCloseById(tx, id);
    if (!dayClose) throw new NotFoundError('Day close');
    assertOutletAccess(dayClose.outletId);
    return dayClose;
  });
}
