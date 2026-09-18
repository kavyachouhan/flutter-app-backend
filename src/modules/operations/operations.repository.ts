import { jsonParam } from '../../db/sql.js';
import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';
import { buildSet } from '../../db/sql.js';

// --- Held bills -------------------------------------------------------------

export interface HeldBillRow {
  id: string;
  outletId: string;
  counterId: string | null;
  deviceId: string;
  label: string | null;
  customerId: string | null;
  customerName: string | null;
  lineCount: number;
  estimatedTotal: number;
  payload: Record<string, unknown>;
  status: 'held' | 'released' | 'discarded';
  invoiceId: string | null;
  heldAt: Date;
  heldBy: string;
  releasedAt: Date | null;
}

const HELD_COLUMNS = `
  id, outlet_id AS "outletId", counter_id AS "counterId", device_id AS "deviceId", label,
  customer_id AS "customerId", customer_name AS "customerName", line_count AS "lineCount",
  estimated_total AS "estimatedTotal", payload, status, invoice_id AS "invoiceId",
  held_at AS "heldAt", held_by AS "heldBy", released_at AS "releasedAt"`;

// --- Expenses ---------------------------------------------------------------

export interface ExpenseCategoryRow {
  id: string;
  name: string;
  isDirect: boolean;
  isActive: boolean;
}

export interface ExpenseRow {
  id: string;
  outletId: string;
  categoryId: string | null;
  categoryName: string | null;
  amount: number;
  mode: string;
  vendorName: string | null;
  reference: string | null;
  note: string | null;
  receiptObjectKey: string | null;
  spentAt: Date;
  spentBy: string;
  status: 'issued' | 'void';
  voidReason: string | null;
  voidedAt: Date | null;
}

export interface ExpenseFilter {
  outletId: string | undefined;
  categoryId: string | undefined;
  mode: string | undefined;
  status: string | undefined;
  from: string | undefined;
  to: string | undefined;
}

const CATEGORY_COLUMNS = 'id, name, is_direct AS "isDirect", is_active AS "isActive"';

const EXPENSE_COLUMNS = `
  e.id, e.outlet_id AS "outletId", e.category_id AS "categoryId", c.name AS "categoryName", e.amount, e.mode,
  e.vendor_name AS "vendorName", e.reference, e.note, e.receipt_object_key AS "receiptObjectKey",
  e.spent_at AS "spentAt", e.spent_by AS "spentBy", e.status, e.void_reason AS "voidReason",
  e.voided_at AS "voidedAt"`;

const EXPENSE_FROM = 'FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id';

const CATEGORY_UPDATABLE = {
  name: 'name',
  isDirect: 'is_direct',
  isActive: 'is_active',
} as const;

// --- Day close --------------------------------------------------------------

export interface DayCloseRow {
  id: string;
  outletId: string;
  counterId: string | null;
  businessDate: string;
  openedAt: Date;
  closedAt: Date;
  openingFloat: number;
  expectedCash: number;
  countedCash: number;
  cashVariance: number;
  tenderBreakdown: Record<string, { expected: number; counted: number | null }>;
  salesTotal: number;
  cashSales: number;
  cashReceipts: number;
  cashRefunds: number;
  cashExpenses: number;
  invoiceCount: number;
  closingFloat: number;
  note: string | null;
  closedBy: string;
}

export interface DayCloseInsert extends Omit<
  DayCloseRow,
  'openedAt' | 'closedAt' | 'businessDate'
> {
  businessDate: string;
  openedAt: string;
  closedAt: string;
}

const DAY_CLOSE_COLUMNS = `
  id, outlet_id AS "outletId", counter_id AS "counterId", business_date AS "businessDate",
  opened_at AS "openedAt", closed_at AS "closedAt", opening_float AS "openingFloat",
  expected_cash AS "expectedCash", counted_cash AS "countedCash", cash_variance AS "cashVariance",
  tender_breakdown AS "tenderBreakdown", sales_total AS "salesTotal", cash_sales AS "cashSales",
  cash_receipts AS "cashReceipts", cash_refunds AS "cashRefunds", cash_expenses AS "cashExpenses",
  invoice_count AS "invoiceCount", closing_float AS "closingFloat", note, closed_by AS "closedBy"`;

/** Totals for one cash-up window, split the way the slip prints them. */
export interface WindowTotals {
  salesTotal: number;
  invoiceCount: number;
  cashSales: number;
  cashReceipts: number;
  cashRefunds: number;
  cashExpenses: number;
  byMode: Record<string, number>;
}

export const operationsRepository = {
  // --- Held bills -----------------------------------------------------------

  findHeldBill(tx: Tx, id: string): Promise<HeldBillRow | undefined> {
    return tx.one<HeldBillRow>(
      `SELECT ${HELD_COLUMNS} FROM held_bills WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  },

  listHeldBills(
    tx: Tx,
    filter: { outletId?: string; counterId?: string; includeReleased: boolean },
    restrictTo: readonly string[] | null,
  ): Promise<HeldBillRow[]> {
    return tx.many<HeldBillRow>(
      `SELECT ${HELD_COLUMNS} FROM held_bills
       WHERE deleted_at IS NULL
         AND ($1::boolean OR status = 'held')
         AND ($2::uuid IS NULL OR outlet_id = $2)
         AND ($3::uuid IS NULL OR counter_id = $3)
         AND ($4::uuid[] IS NULL OR outlet_id = ANY($4::uuid[]))
       ORDER BY held_at DESC, id DESC`,
      [
        filter.includeReleased,
        filter.outletId ?? null,
        filter.counterId ?? null,
        restrictTo ? [...restrictTo] : null,
      ],
    );
  },

  /**
   * Upsert, because a device re-parks the same draft as the cashier keeps
   * adding lines to it; the id stays the same for the life of the draft.
   */
  async upsertHeldBill(
    tx: Tx,
    b: {
      id: string;
      outletId: string;
      counterId: string | null;
      deviceId: string;
      label: string | null;
      customerId: string | null;
      customerName: string | null;
      lineCount: number;
      estimatedTotal: number;
      payload: Record<string, unknown>;
      heldAt: string;
      heldBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO held_bills (id, tenant_id, outlet_id, counter_id, device_id, label, customer_id, customer_name,
         line_count, estimated_total, payload, status, held_at, held_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'held', $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         customer_id = EXCLUDED.customer_id,
         customer_name = EXCLUDED.customer_name,
         line_count = EXCLUDED.line_count,
         estimated_total = EXCLUDED.estimated_total,
         payload = EXCLUDED.payload,
         held_at = EXCLUDED.held_at
       WHERE held_bills.status = 'held'`,
      [
        b.id,
        b.outletId,
        b.counterId,
        b.deviceId,
        b.label,
        b.customerId,
        b.customerName,
        b.lineCount,
        b.estimatedTotal,
        JSON.stringify(b.payload),
        b.heldAt,
        b.heldBy,
      ],
    );
  },

  async countOpenHeldBills(tx: Tx, outletId: string, counterId: string | null): Promise<number> {
    const row = await tx.one<{ open: number }>(
      `SELECT count(*)::int AS open FROM held_bills
       WHERE status = 'held' AND deleted_at IS NULL AND outlet_id = $1
         AND counter_id IS NOT DISTINCT FROM $2`,
      [outletId, counterId],
    );
    return row?.open ?? 0;
  },

  async releaseHeldBill(
    tx: Tx,
    id: string,
    outcome: 'released' | 'discarded',
    invoiceId: string | null,
    userId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE held_bills
         SET status = $2, invoice_id = $3, released_at = now(), released_by = $4, deleted_at = now()
       WHERE id = $1`,
      [id, outcome, invoiceId, userId],
    );
  },

  // --- Expense categories ---------------------------------------------------

  listExpenseCategories(tx: Tx): Promise<ExpenseCategoryRow[]> {
    return tx.many<ExpenseCategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM expense_categories WHERE deleted_at IS NULL ORDER BY name`,
    );
  },

  findExpenseCategory(tx: Tx, id: string): Promise<ExpenseCategoryRow | undefined> {
    return tx.one<ExpenseCategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM expense_categories WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  },

  async insertExpenseCategory(
    tx: Tx,
    c: { id: string; name: string; isDirect: boolean },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO expense_categories (id, tenant_id, name, is_direct)
       VALUES ($1, app.current_tenant_id(), $2, $3)`,
      [c.id, c.name, c.isDirect],
    );
  },

  async updateExpenseCategory(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, CATEGORY_UPDATABLE, 2);
    if (clause) {
      await tx.query(`UPDATE expense_categories SET ${clause} WHERE id = $1`, [id, ...values]);
    }
  },

  async softDeleteExpenseCategory(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE expense_categories SET deleted_at = now() WHERE id = $1', [id]);
  },

  async expenseCategoryInUse(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ inUse: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM expenses WHERE category_id = $1 AND status = 'issued') AS "inUse"`,
      [id],
    );
    return row?.inUse ?? false;
  },

  // --- Expenses -------------------------------------------------------------

  async expenseExists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM expenses WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  findExpense(tx: Tx, id: string, forUpdate = false): Promise<ExpenseRow | undefined> {
    return tx.one<ExpenseRow>(
      `SELECT ${EXPENSE_COLUMNS} ${EXPENSE_FROM} WHERE e.id = $1 ${forUpdate ? 'FOR UPDATE OF e' : ''}`,
      [id],
    );
  },

  async insertExpense(
    tx: Tx,
    e: {
      id: string;
      outletId: string;
      categoryId: string | null;
      amount: number;
      mode: string;
      vendorName: string | null;
      reference: string | null;
      note: string | null;
      receiptObjectKey: string | null;
      spentAt: string;
      spentBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO expenses (id, tenant_id, outlet_id, category_id, amount, mode, vendor_name, reference, note,
         receipt_object_key, spent_at, spent_by, status)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'issued')`,
      [
        e.id,
        e.outletId,
        e.categoryId,
        e.amount,
        e.mode,
        e.vendorName,
        e.reference,
        e.note,
        e.receiptObjectKey,
        e.spentAt,
        e.spentBy,
      ],
    );
  },

  listExpenses(
    tx: Tx,
    filter: ExpenseFilter,
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<ExpenseRow[]> {
    return tx.many<ExpenseRow>(
      `SELECT ${EXPENSE_COLUMNS} ${EXPENSE_FROM}
       WHERE ($1::uuid IS NULL OR e.outlet_id = $1)
         AND ($2::uuid IS NULL OR e.category_id = $2)
         AND ($3::text IS NULL OR e.mode = $3)
         AND ($4::text IS NULL OR e.status = $4)
         AND ($5::timestamptz IS NULL OR e.spent_at >= $5)
         AND ($6::timestamptz IS NULL OR e.spent_at < $6)
         AND ($7::uuid[] IS NULL OR e.outlet_id = ANY($7::uuid[]))
         AND ($8::timestamptz IS NULL OR (e.spent_at, e.id) < ($8::timestamptz, $9::uuid))
       ORDER BY e.spent_at DESC, e.id DESC
       LIMIT $10`,
      [
        filter.outletId ?? null,
        filter.categoryId ?? null,
        filter.mode ?? null,
        filter.status ?? null,
        filter.from ?? null,
        filter.to ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async markExpenseVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      "UPDATE expenses SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3 WHERE id = $1",
      [id, reason, userId],
    );
  },

  // --- Day close ------------------------------------------------------------

  findDayClose(
    tx: Tx,
    outletId: string,
    counterId: string | null,
    businessDate: string,
  ): Promise<DayCloseRow | undefined> {
    return tx.one<DayCloseRow>(
      `SELECT ${DAY_CLOSE_COLUMNS} FROM day_closes
       WHERE outlet_id = $1 AND counter_id IS NOT DISTINCT FROM $2 AND business_date = $3`,
      [outletId, counterId, businessDate],
    );
  },

  findDayCloseById(tx: Tx, id: string): Promise<DayCloseRow | undefined> {
    return tx.one<DayCloseRow>(`SELECT ${DAY_CLOSE_COLUMNS} FROM day_closes WHERE id = $1`, [id]);
  },

  /** The close this one continues from, so the window has a start. */
  findPreviousDayClose(
    tx: Tx,
    outletId: string,
    counterId: string | null,
    before: string,
  ): Promise<DayCloseRow | undefined> {
    return tx.one<DayCloseRow>(
      `SELECT ${DAY_CLOSE_COLUMNS} FROM day_closes
       WHERE outlet_id = $1 AND counter_id IS NOT DISTINCT FROM $2 AND closed_at <= $3
       ORDER BY closed_at DESC LIMIT 1`,
      [outletId, counterId, before],
    );
  },

  listDayCloses(
    tx: Tx,
    filter: { outletId?: string; from?: string; to?: string },
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<DayCloseRow[]> {
    return tx.many<DayCloseRow>(
      `SELECT ${DAY_CLOSE_COLUMNS} FROM day_closes
       WHERE ($1::uuid IS NULL OR outlet_id = $1)
         AND ($2::date IS NULL OR business_date >= $2)
         AND ($3::date IS NULL OR business_date <= $3)
         AND ($4::uuid[] IS NULL OR outlet_id = ANY($4::uuid[]))
         AND ($5::timestamptz IS NULL OR (closed_at, id) < ($5::timestamptz, $6::uuid))
       ORDER BY closed_at DESC, id DESC
       LIMIT $7`,
      [
        filter.outletId ?? null,
        filter.from ?? null,
        filter.to ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async insertDayClose(tx: Tx, d: DayCloseInsert): Promise<void> {
    await tx.query(
      `INSERT INTO day_closes (id, tenant_id, outlet_id, counter_id, business_date, opened_at, closed_at,
         opening_float, expected_cash, counted_cash, cash_variance, tender_breakdown, sales_total, cash_sales,
         cash_receipts, cash_refunds, cash_expenses, invoice_count, closing_float, note, closed_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15,
               $16, $17, $18, $19, $20)`,
      [
        d.id,
        d.outletId,
        d.counterId,
        d.businessDate,
        d.openedAt,
        d.closedAt,
        d.openingFloat,
        d.expectedCash,
        d.countedCash,
        d.cashVariance,
        jsonParam(d.tenderBreakdown),
        d.salesTotal,
        d.cashSales,
        d.cashReceipts,
        d.cashRefunds,
        d.cashExpenses,
        d.invoiceCount,
        d.closingFloat,
        d.note,
        d.closedBy,
      ],
    );
  },

  /**
   * Every figure the cash-up needs, in one round trip.
   *
   * Voided documents are excluded throughout: a bill voided before the close
   * never put money in the drawer. Tenders are attributed by the payment row,
   * not by the invoice, so a split-tender bill contributes to each mode.
   */
  async windowTotals(
    tx: Tx,
    scope: { outletId: string; counterId: string | null; from: string; to: string },
  ): Promise<WindowTotals> {
    const params = [scope.outletId, scope.counterId, scope.from, scope.to];

    const sales = await tx.one<{ salesTotal: number; invoiceCount: number }>(
      `SELECT COALESCE(SUM(grand_total), 0)::bigint AS "salesTotal", count(*)::int AS "invoiceCount"
       FROM invoices
       WHERE outlet_id = $1 AND ($2::uuid IS NULL OR counter_id = $2)
         AND status = 'issued' AND issued_at >= $3 AND issued_at < $4`,
      params,
    );

    // Counter scoping only applies to invoice tenders: a receipt or an expense
    // is recorded against the outlet, not a till.
    const byModeRows = await tx.many<{ mode: string; kind: string; total: number }>(
      `SELECT p.mode, p.kind, COALESCE(SUM(p.amount), 0)::bigint AS total
       FROM payments p
       WHERE p.outlet_id = $1 AND p.status = 'issued' AND p.received_at >= $3 AND p.received_at < $4
         AND ($2::uuid IS NULL OR p.kind <> 'invoice_tender' OR EXISTS (
           SELECT 1 FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
           WHERE pa.payment_id = p.id AND i.counter_id = $2))
       GROUP BY p.mode, p.kind`,
      params,
    );

    const expenses = await tx.one<{ cashExpenses: number }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS "cashExpenses" FROM expenses
       WHERE outlet_id = $1 AND status = 'issued' AND mode = 'cash'
         AND spent_at >= $3 AND spent_at < $4`,
      params,
    );

    const byMode: Record<string, number> = {};
    let cashSales = 0;
    let cashReceipts = 0;
    let cashRefunds = 0;
    for (const row of byModeRows) {
      const signed = row.kind === 'refund' ? -row.total : row.total;
      byMode[row.mode] = (byMode[row.mode] ?? 0) + signed;
      if (row.mode === 'cash') {
        if (row.kind === 'invoice_tender') cashSales += row.total;
        else if (row.kind === 'receipt') cashReceipts += row.total;
        else cashRefunds += row.total;
      }
    }

    return {
      salesTotal: sales?.salesTotal ?? 0,
      invoiceCount: sales?.invoiceCount ?? 0,
      cashSales,
      cashReceipts,
      cashRefunds,
      cashExpenses: expenses?.cashExpenses ?? 0,
      byMode,
    };
  },

  /** The first money movement after [from], so an untouched day has no window. */
  async firstActivityAt(
    tx: Tx,
    scope: { outletId: string; from: string },
  ): Promise<Date | undefined> {
    const row = await tx.one<{ at: Date | null }>(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(issued_at) AS at FROM invoices
           WHERE outlet_id = $1 AND issued_at >= $2
         UNION ALL
         SELECT MIN(received_at) FROM payments WHERE outlet_id = $1 AND received_at >= $2
         UNION ALL
         SELECT MIN(spent_at) FROM expenses WHERE outlet_id = $1 AND spent_at >= $2
       ) firsts`,
      [scope.outletId, scope.from],
    );
    return row?.at ?? undefined;
  },
};
