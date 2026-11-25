/**
 * Sync: the change feed devices pull and the operation batches they push.
 *
 * Push holds no business logic. Each operation is validated with the same
 * schema its REST endpoint uses and dispatched to the same service function,
 * inside that function's own transaction — one transaction per operation, so
 * a batch of 200 offline invoices with one bad total applies the other 199.
 * The batch answers HTTP 200 with a per-operation status; a client retries
 * only the operations marked `retryable`.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, withTransaction, runInTransactionScope, type Tx } from '../../db/tx.js';
import { getContext, requireAuthContext } from '../../lib/context.js';
import {
  AppError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isAppError,
  WarningCode,
  type ErrorCodeValue,
} from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { createLogger } from '../../lib/logger.js';
import { syncOperations, syncPullChanges } from '../../observability/metrics.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import * as catalogueService from '../catalogue/catalogue.service.js';
import * as creditNotesService from '../credit-notes/credit-notes.service.js';
import * as customersService from '../customers/customers.service.js';
import * as estimatesService from '../estimates/estimates.service.js';
import * as proformaInvoicesService from '../proforma-invoices/proforma-invoices.service.js';
import * as adjustmentNotes from '../adjustment-notes/adjustment-notes.service.js';
import * as invoicesService from '../invoices/invoices.service.js';
import type { BlockRow } from '../numbering/numbering.repository.js';
import * as operationsService from '../operations/operations.service.js';
import { topUpLeasesForDevice } from '../numbering/numbering.service.js';
import * as paymentsService from '../payments/payments.service.js';
import * as debitNotesService from '../debit-notes/debit-notes.service.js';
import * as purchasesService from '../purchases/purchases.service.js';
import * as purchaseOrdersService from '../purchases/orders.service.js';
import * as saleOrdersService from '../sales-orders/sales-orders.service.js';
import * as stockService from '../stock/stock.service.js';
import * as suppliersService from '../suppliers/suppliers.service.js';
import * as termsService from '../terms/terms.service.js';
import {
  claimOperationKey,
  completeOperationKey,
  payloadHash,
  purgeExpiredKeys,
} from './operation-keys.js';
import {
  FIELD_MERGE_TABLES,
  findMergeTarget,
  mergeEntityOf,
  mergeUpdate,
  recordAlias,
  recordConflicts,
  resolveAliases,
  tenantHasAliases,
  type FieldMerge,
  type MergedInto,
} from './merge.js';
import { SYNC_TABLES } from './sync.registry.js';
import { syncRepository, type ChangeRow } from './sync.repository.js';
import {
  OPERATION_PAYLOADS,
  type OperationType,
  type PullQuery,
  type PushBody,
  type PushOperation,
} from './sync.schemas.js';

const log = createLogger('sync');

// --- Pull ------------------------------------------------------------------

export interface Change {
  entity: string;
  op: 'upsert' | 'delete';
  serverSeq: number;
  row: Record<string, unknown>;
}

export interface PullResult {
  changes: Change[];
  /** Pass back as `since` on the next call once every change is applied. */
  nextSince: number;
  hasMore: boolean;
  /** Blocks leased during this pull; upsert them locally. */
  leases: BlockRow[];
  serverTime: string;
}

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function toChange(row: ChangeRow): Change {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.row)) out[camel(k)] = v;
  return {
    entity: row.entity,
    op: row.deleted ? 'delete' : 'upsert',
    serverSeq: row.serverSeq,
    row: out,
  };
}

export function pullChanges(query: PullQuery): Promise<PullResult> {
  const auth = requireAuthContext();
  const startedAt = new Date();
  const limit = Math.min(query.limit ?? env.SYNC_PULL_MAX_CHANGES, env.SYNC_PULL_MAX_CHANGES);

  return withTransaction(
    async (tx) => {
      const state = await syncRepository.beginPull(tx, auth.deviceId, query.since);
      if (state.fullResyncRequired) {
        if (query.since > 0) {
          throw new ConflictError(
            'This device must resync from the beginning. Clear local data and pull with since=0.',
            ErrorCode.SYNC_RESET_REQUIRED,
          );
        }
        await syncRepository.clearResetFlag(tx, auth.deviceId);
      }

      const rows = await syncRepository.listChanges(tx, query.since, limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const changes = page.map(toChange);
      // Never max(server_seq): only what was actually emitted is safe to skip past.
      const nextSince = changes.length > 0 ? changes[changes.length - 1]!.serverSeq : query.since;

      for (const c of changes) syncPullChanges.inc({ entity: c.entity });

      const leases = await topUpLeasesForDevice(tx, auth.deviceId, {
        threshold: env.SYNC_LEASE_TOPUP_THRESHOLD,
        rolloverLeadDays: env.SYNC_FY_ROLLOVER_LEAD_DAYS,
        now: startedAt,
      });

      await syncRepository.insertBatch(tx, {
        id: newId(),
        deviceId: auth.deviceId,
        kind: 'pull',
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        sinceSeq: query.since,
        untilSeq: nextSince,
        changes: changes.length,
        requestId: getContext()?.requestId,
      });

      return { changes, nextSince, hasMore, leases, serverTime: new Date().toISOString() };
    },
    { isolation: 'repeatable_read' },
  );
}

export function getState() {
  const auth = requireAuthContext();
  return withReadTransaction(async (tx) => ({
    ...(await syncRepository.getState(tx, auth.deviceId)),
    serverTime: new Date().toISOString(),
    entities: SYNC_TABLES.map((t) => ({
      entity: t.entity,
      keyColumns: t.keyColumns.map(camel),
      softDelete: t.softDelete,
      pushedBy: t.pushedBy,
    })),
  }));
}

// --- Push ------------------------------------------------------------------

export type OperationStatus = 'applied' | 'replayed' | 'rejected';

export interface OperationResult {
  opId: string;
  type: OperationType;
  status: OperationStatus;
  /** The affected row's id and version, so the device can stamp its local copy. */
  id?: string;
  serverSeq?: number;
  warnings?: unknown[];
  /**
   * Present on an `applied` create that was matched to a record that already existed: the device
   * must treat its own id as that record from now on. Additive on purpose — a new status would make
   * an older build refuse the whole answer.
   */
  mergedInto?: MergedInto;
  error?: { code: ErrorCodeValue; message: string; details?: Record<string, unknown> };
  /** Only on `rejected`: whether the same operation may succeed later. */
  retryable?: boolean;
}

export interface PushResult {
  results: OperationResult[];
  serverTime: string;
}

const OPERATION_PERMISSIONS: Record<OperationType, Permission> = {
  'invoice.create': 'invoices:create',
  'invoice.void': 'invoices:void',
  'invoice.printed': 'invoices:read',
  'credit_note.create': 'credit_notes:create',
  'credit_note.void': 'credit_notes:void',
  'sales_debit_note.create': 'credit_notes:create',
  'sales_debit_note.void': 'credit_notes:void',
  'financial_credit_note.create': 'credit_notes:create',
  'financial_credit_note.void': 'credit_notes:void',
  'credit_note.printed': 'credit_notes:read',
  'payment.create': 'payments:create',
  'payment.void': 'payments:void',
  'customer.create': 'customers:write',
  'customer.update': 'customers:write',
  'customer.delete': 'customers:write',
  'customer_address.upsert': 'customers:write',
  'customer_address.delete': 'customers:write',
  'item.create': 'catalogue:write',
  'item.update': 'catalogue:write',
  'item.delete': 'catalogue:write',
  'category.create': 'catalogue:write',
  'category.update': 'catalogue:write',
  'category.delete': 'catalogue:write',
  'terms.create': 'terms:write',
  'terms.update': 'terms:write',
  'terms.delete': 'terms:write',
  'stock.adjust': 'stock:adjust',
  'held_bill.upsert': 'invoices:create',
  'held_bill.release': 'invoices:create',
  'expense.create': 'expenses:write',
  'expense.void': 'expenses:void',
  'expense_category.create': 'expenses:write',
  'expense_category.update': 'expenses:write',
  'expense_category.delete': 'expenses:write',
  'day_close.create': 'day_close:create',
  // The REST routes guard purchase orders with the purchases permissions: create, edit and
  // cancel with `create`, delete with `void`.
  'supplier.create': 'suppliers:write',
  'supplier.update': 'suppliers:write',
  'supplier.delete': 'suppliers:write',
  'purchase_bill.create': 'purchases:create',
  'purchase_bill.void': 'purchases:void',
  'supplier_payment.create': 'purchases:create',
  'supplier_payment.void': 'purchases:void',
  'debit_note.create': 'debit_notes:create',
  'debit_note.void': 'debit_notes:void',
  'estimate.create': 'estimates:create',
  'estimate.update': 'estimates:update',
  'estimate.delete': 'estimates:delete',
  'estimate.cancel': 'estimates:update',
  'estimate.close': 'estimates:update',
  'estimate.convert': 'estimates:convert',
  'proforma_invoice.create': 'proforma_invoices:create',
  'proforma_invoice.update': 'proforma_invoices:update',
  'proforma_invoice.delete': 'proforma_invoices:delete',
  'proforma_invoice.cancel': 'proforma_invoices:update',
  'proforma_invoice.close': 'proforma_invoices:update',
  'sale_order.create': 'sales_orders:create',
  'sale_order.update': 'sales_orders:update',
  'sale_order.delete': 'sales_orders:delete',
  'sale_order.cancel': 'sales_orders:cancel',
  'sale_order.close': 'sales_orders:cancel',
  'purchase_order.create': 'purchases:create',
  'purchase_order.update': 'purchases:create',
  'purchase_order.delete': 'purchases:void',
  'purchase_order.cancel': 'purchases:create',
};

/** Table a create/update touches, for replay detection and stale-write checks. */
const OPERATION_TABLE: Partial<Record<OperationType, string>> = {
  'payment.create': 'payments',
  'customer.create': 'customers',
  'customer.update': 'customers',
  'customer.delete': 'customers',
  'customer_address.upsert': 'customer_addresses',
  'customer_address.delete': 'customer_addresses',
  'item.create': 'items',
  'item.update': 'items',
  'item.delete': 'items',
  'category.create': 'categories',
  'category.update': 'categories',
  'category.delete': 'categories',
  'terms.create': 'terms_conditions',
  'terms.update': 'terms_conditions',
  'terms.delete': 'terms_conditions',
  'stock.adjust': 'stock_ledger_entries',
  'held_bill.upsert': 'held_bills',
  'expense.create': 'expenses',
  'expense_category.create': 'expense_categories',
  'expense_category.update': 'expense_categories',
  'expense_category.delete': 'expense_categories',
  'day_close.create': 'day_closes',
  'supplier.create': 'suppliers',
  'supplier.update': 'suppliers',
  'supplier.delete': 'suppliers',
  'purchase_bill.create': 'purchase_bills',
  'supplier_payment.create': 'supplier_payments',
  'debit_note.create': 'debit_notes',
  'estimate.create': 'estimates',
  'estimate.update': 'estimates',
  'estimate.delete': 'estimates',
  'estimate.cancel': 'estimates',
  'estimate.close': 'estimates',
  'estimate.convert': 'estimates',
  'proforma_invoice.create': 'proforma_invoices',
  'proforma_invoice.update': 'proforma_invoices',
  'proforma_invoice.delete': 'proforma_invoices',
  'proforma_invoice.cancel': 'proforma_invoices',
  'proforma_invoice.close': 'proforma_invoices',
  'sale_order.create': 'sales_orders',
  'sale_order.update': 'sales_orders',
  'sale_order.delete': 'sales_orders',
  'sale_order.cancel': 'sales_orders',
  'sale_order.close': 'sales_orders',
  'purchase_order.create': 'purchase_orders',
  'purchase_order.update': 'purchase_orders',
  'purchase_order.delete': 'purchase_orders',
  'purchase_order.cancel': 'purchase_orders',
};

type Payload<T extends OperationType> = (typeof OPERATION_PAYLOADS)[T]['_output'];

interface Applied {
  id: string;
  replayed?: boolean;
  warnings?: unknown[];
}

/** A retried delete finds it already gone; that is the outcome asked for. */
function ignoreNotFound(error: unknown): void {
  if (!(error instanceof NotFoundError)) throw error;
}

/** Every branch calls the same service the REST route calls. */
async function dispatch(type: OperationType, payload: unknown): Promise<Applied> {
  switch (type) {
    case 'invoice.create': {
      const p = payload as Payload<'invoice.create'>;
      const r = await invoicesService.createInvoice(p);
      return { id: p.id, replayed: r.replayed, warnings: r.warnings };
    }
    case 'invoice.void': {
      const p = payload as Payload<'invoice.void'>;
      await invoicesService.voidInvoice(p.id, p.reason);
      return { id: p.id };
    }
    case 'invoice.printed': {
      const p = payload as Payload<'invoice.printed'>;
      await invoicesService.markPrinted(p.id);
      return { id: p.id };
    }
    case 'sales_debit_note.create': {
      const p = payload as Payload<'sales_debit_note.create'>;
      const r = await adjustmentNotes.createSalesDebitNote(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'sales_debit_note.void': {
      const p = payload as Payload<'sales_debit_note.void'>;
      await adjustmentNotes.voidSalesDebitNote(p.id, p.reason);
      return { id: p.id };
    }
    case 'financial_credit_note.create': {
      const p = payload as Payload<'financial_credit_note.create'>;
      const r = await adjustmentNotes.createFinancialCreditNote(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'financial_credit_note.void': {
      const p = payload as Payload<'financial_credit_note.void'>;
      await adjustmentNotes.voidFinancialCreditNote(p.id, p.reason);
      return { id: p.id };
    }
    case 'credit_note.create': {
      const p = payload as Payload<'credit_note.create'>;
      const r = await creditNotesService.createCreditNote(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'credit_note.void': {
      const p = payload as Payload<'credit_note.void'>;
      await creditNotesService.voidCreditNote(p.id, p.reason);
      return { id: p.id };
    }
    case 'credit_note.printed': {
      const p = payload as Payload<'credit_note.printed'>;
      await creditNotesService.markPrinted(p.id);
      return { id: p.id };
    }
    case 'payment.create': {
      const p = payload as Payload<'payment.create'>;
      await paymentsService.createReceipt(p);
      return { id: p.id };
    }
    case 'payment.void': {
      const p = payload as Payload<'payment.void'>;
      await paymentsService.voidReceipt(p.id, p.reason);
      return { id: p.id };
    }
    case 'customer.create': {
      const p = payload as Payload<'customer.create'>;
      await customersService.createCustomer(p);
      return { id: p.id };
    }
    case 'customer.update': {
      const p = payload as Payload<'customer.update'>;
      await customersService.updateCustomer(p.id, p.patch);
      return { id: p.id };
    }
    case 'item.create': {
      const p = payload as Payload<'item.create'>;
      await catalogueService.createItem(p);
      return { id: p.id };
    }
    case 'item.update': {
      const p = payload as Payload<'item.update'>;
      await catalogueService.updateItem(p.id, p.patch);
      return { id: p.id };
    }
    case 'category.create': {
      const p = payload as Payload<'category.create'>;
      await catalogueService.createCategory(p);
      return { id: p.id };
    }
    case 'category.update': {
      const p = payload as Payload<'category.update'>;
      await catalogueService.updateCategory(p.id, p.patch);
      return { id: p.id };
    }
    case 'customer_address.upsert': {
      const p = payload as Payload<'customer_address.upsert'>;
      await customersService.upsertCustomerAddress(p);
      return { id: p.id };
    }
    case 'customer_address.delete': {
      const p = payload as Payload<'customer_address.delete'>;
      await customersService.deleteCustomerAddress(p.customerId, p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'customer.delete': {
      const p = payload as Payload<'customer.delete'>;
      await customersService.deleteCustomer(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'item.delete': {
      const p = payload as Payload<'item.delete'>;
      await catalogueService.deleteItem(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'category.delete': {
      const p = payload as Payload<'category.delete'>;
      await catalogueService.deleteCategory(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'terms.create': {
      const p = payload as Payload<'terms.create'>;
      await termsService.createTerms(p);
      return { id: p.id };
    }
    case 'terms.update': {
      const p = payload as Payload<'terms.update'>;
      await termsService.updateTerms(p.id, p.patch);
      return { id: p.id };
    }
    case 'terms.delete': {
      const p = payload as Payload<'terms.delete'>;
      // A retried delete finds it already gone; that is the outcome asked for.
      await termsService.deleteTerms(p.id).catch((error: unknown) => {
        if (!(error instanceof NotFoundError)) throw error;
      });
      return { id: p.id };
    }
    case 'stock.adjust': {
      const p = payload as Payload<'stock.adjust'>;
      await stockService.createAdjustment(p);
      return { id: p.id };
    }
    case 'held_bill.upsert': {
      const p = payload as Payload<'held_bill.upsert'>;
      await operationsService.upsertHeldBill(p);
      return { id: p.id };
    }
    case 'held_bill.release': {
      const p = payload as Payload<'held_bill.release'>;
      const r = await operationsService.releaseHeldBill(p.id, p);
      // Already released, here or on another device: not an error, just done.
      return { id: p.id, replayed: !r.released };
    }
    case 'expense.create': {
      const p = payload as Payload<'expense.create'>;
      const r = await operationsService.createExpense(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'expense.void': {
      const p = payload as Payload<'expense.void'>;
      await operationsService.voidExpense(p.id, p.reason);
      return { id: p.id };
    }
    case 'expense_category.create': {
      const p = payload as Payload<'expense_category.create'>;
      await operationsService.createExpenseCategory(p);
      return { id: p.id };
    }
    case 'expense_category.update': {
      const p = payload as Payload<'expense_category.update'>;
      await operationsService.updateExpenseCategory(p.id, p.patch);
      return { id: p.id };
    }
    case 'expense_category.delete': {
      const p = payload as Payload<'expense_category.delete'>;
      await operationsService.deleteExpenseCategory(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'day_close.create': {
      const p = payload as Payload<'day_close.create'>;
      const r = await operationsService.createDayClose(p);
      return { id: p.id, replayed: r.replayed, warnings: r.warnings };
    }
    case 'supplier.create': {
      const p = payload as Payload<'supplier.create'>;
      await suppliersService.createSupplier(p);
      return { id: p.id };
    }
    case 'supplier.update': {
      const p = payload as Payload<'supplier.update'>;
      await suppliersService.updateSupplier(p.id, p.patch);
      return { id: p.id };
    }
    case 'supplier.delete': {
      const p = payload as Payload<'supplier.delete'>;
      await suppliersService.deleteSupplier(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'purchase_bill.create': {
      const p = payload as Payload<'purchase_bill.create'>;
      const r = await purchasesService.createPurchaseBill(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'purchase_bill.void': {
      const p = payload as Payload<'purchase_bill.void'>;
      await purchasesService.voidPurchaseBill(p.id, p.reason);
      return { id: p.id };
    }
    case 'supplier_payment.create': {
      const p = payload as Payload<'supplier_payment.create'>;
      await purchasesService.createSupplierPayment(p);
      return { id: p.id };
    }
    case 'supplier_payment.void': {
      const p = payload as Payload<'supplier_payment.void'>;
      await purchasesService.voidSupplierPayment(p.id, p.reason);
      return { id: p.id };
    }
    case 'debit_note.create': {
      const p = payload as Payload<'debit_note.create'>;
      const r = await debitNotesService.createDebitNote(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'debit_note.void': {
      const p = payload as Payload<'debit_note.void'>;
      await debitNotesService.voidDebitNote(p.id, p.reason);
      return { id: p.id };
    }
    case 'estimate.create': {
      const p = payload as Payload<'estimate.create'>;
      const r = await estimatesService.createEstimate(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'estimate.update': {
      const p = payload as Payload<'estimate.update'>;
      await estimatesService.updateEstimate(p.id, p);
      return { id: p.id };
    }
    case 'estimate.delete': {
      const p = payload as Payload<'estimate.delete'>;
      await estimatesService.deleteEstimate(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'estimate.cancel': {
      const p = payload as Payload<'estimate.cancel'>;
      await estimatesService.cancelEstimate(p.id, p);
      return { id: p.id };
    }
    case 'estimate.close': {
      const p = payload as Payload<'estimate.close'>;
      await estimatesService.closeEstimate(p.id);
      return { id: p.id };
    }
    case 'estimate.convert': {
      const p = payload as Payload<'estimate.convert'>;
      const { orderId, ...rest } = p;
      // A retry after a lost response: this very conversion already happened, so say so rather
      // than reject it as "already converted" and leave the device believing it failed.
      const done = await withReadTransaction((tx) =>
        tx.one<{ convertedToId: string | null }>(
          `SELECT converted_to_id AS "convertedToId" FROM estimates WHERE id = $1 AND status = 'converted'`,
          [p.id],
        ),
      );
      if (done?.convertedToId === orderId) return { id: p.id, replayed: true };
      const r = await estimatesService.convertEstimateToSalesOrder(
        p.id,
        { ...rest, id: orderId },
        { warnOnDiscountCap: true },
      );
      return { id: p.id, warnings: r.warnings };
    }
    case 'proforma_invoice.create': {
      const p = payload as Payload<'proforma_invoice.create'>;
      const r = await proformaInvoicesService.createProformaInvoice(p);
      return { id: p.id, replayed: r.replayed };
    }
    case 'proforma_invoice.update': {
      const p = payload as Payload<'proforma_invoice.update'>;
      await proformaInvoicesService.updateProformaInvoice(p.id, p);
      return { id: p.id };
    }
    case 'proforma_invoice.delete': {
      const p = payload as Payload<'proforma_invoice.delete'>;
      await proformaInvoicesService.deleteProformaInvoice(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'proforma_invoice.cancel': {
      const p = payload as Payload<'proforma_invoice.cancel'>;
      await proformaInvoicesService.cancelProformaInvoice(p.id, p);
      return { id: p.id };
    }
    case 'proforma_invoice.close': {
      const p = payload as Payload<'proforma_invoice.close'>;
      await proformaInvoicesService.closeProformaInvoice(p.id);
      return { id: p.id };
    }
    case 'sale_order.create': {
      const p = payload as Payload<'sale_order.create'>;
      const r = await saleOrdersService.createSaleOrder(p, { warnOnDiscountCap: true });
      return { id: p.id, replayed: r.replayed, warnings: r.warnings };
    }
    case 'sale_order.update': {
      const p = payload as Payload<'sale_order.update'>;
      const r = await saleOrdersService.updateSaleOrder(p.id, p);
      return { id: p.id, warnings: r.warnings };
    }
    case 'sale_order.delete': {
      const p = payload as Payload<'sale_order.delete'>;
      await saleOrdersService
        .deleteSaleOrder(p.id, p.refundMode ? { refundMode: p.refundMode } : {})
        .catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'sale_order.cancel': {
      const p = payload as Payload<'sale_order.cancel'>;
      await saleOrdersService.cancelSaleOrder(p.id, p);
      return { id: p.id };
    }
    case 'sale_order.close': {
      const p = payload as Payload<'sale_order.close'>;
      await saleOrdersService.closeSaleOrder(
        p.id,
        p.refundMode ? { refundMode: p.refundMode } : {},
      );
      return { id: p.id };
    }
    case 'purchase_order.create': {
      const p = payload as Payload<'purchase_order.create'>;
      await purchaseOrdersService.createPurchaseOrder(p);
      return { id: p.id };
    }
    case 'purchase_order.update': {
      const p = payload as Payload<'purchase_order.update'>;
      await purchaseOrdersService.updatePurchaseOrder(p.id, p);
      return { id: p.id };
    }
    case 'purchase_order.delete': {
      const p = payload as Payload<'purchase_order.delete'>;
      await purchaseOrdersService.deletePurchaseOrder(p.id).catch(ignoreNotFound);
      return { id: p.id };
    }
    case 'purchase_order.cancel': {
      const p = payload as Payload<'purchase_order.cancel'>;
      await purchaseOrdersService.cancelPurchaseOrder(p.id, p.reason);
      return { id: p.id };
    }
  }
}

/**
 * A rejection is retryable when the cause is the server's condition, not the
 * operation's content: an outage, a lock conflict, throttling. Everything the
 * device could fix by changing the operation (or cannot fix at all, like a
 * totals mismatch) is terminal, so the outbox does not loop on it forever.
 */
function isRetryable(error: unknown): boolean {
  if (!isAppError(error)) return true;
  if (error.statusCode >= 500) return true;
  if (error.code === ErrorCode.RATE_LIMITED) return true;
  if (error.code === ErrorCode.CONFLICT && error.retryAfterSeconds !== undefined) return true;
  return false;
}

async function probe(
  tx: Tx,
  table: string,
  id: string,
): Promise<{ exists: boolean; serverSeq: number | undefined }> {
  const serverSeq = await syncRepository.serverSeqOf(tx, table, id);
  return { exists: serverSeq !== undefined, serverSeq };
}

/** What one push remembers between its operations. */
interface PushBatchState {
  /** Whether any alias exists yet, so a business that never merged pays no lookup per operation. */
  aliasesPossible: boolean;
}

async function runOperation(
  op: PushOperation,
  role: Parameters<typeof hasPermission>[0],
  batch: PushBatchState,
): Promise<OperationResult> {
  const base: Pick<OperationResult, 'opId' | 'type'> = { opId: op.opId, type: op.type };

  const rejected = (error: unknown): OperationResult => {
    const appError = isAppError(error)
      ? error
      : new AppError(500, ErrorCode.INTERNAL, 'An unexpected error occurred.', { cause: error });
    if (!isAppError(error) || error.statusCode >= 500)
      log.error({ err: error, opId: op.opId, type: op.type }, 'Sync op failed');
    return {
      ...base,
      status: 'rejected',
      retryable: isRetryable(error),
      error: {
        code: appError.code,
        message: appError.isOperational ? appError.message : 'An unexpected error occurred.',
        ...(appError.details ? { details: appError.details } : {}),
      },
    };
  };

  if (!hasPermission(role, OPERATION_PERMISSIONS[op.type])) {
    return rejected(
      new ForbiddenError(undefined, ErrorCode.INSUFFICIENT_ROLE, {
        details: { required: OPERATION_PERMISSIONS[op.type] },
      }),
    );
  }

  const parsed = OPERATION_PAYLOADS[op.type].safeParse(op.payload);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join('.')] ??= issue.message;
    return rejected(new ValidationError(undefined, { details: { fields } }));
  }
  const payload = parsed.data;
  const table = OPERATION_TABLE[op.type];
  const seqTable =
    table ??
    (op.type.startsWith('invoice.')
      ? 'invoices'
      : op.type.startsWith('credit_note.')
        ? 'credit_notes'
        : undefined);
  const auth = requireAuthContext();

  try {
    // One transaction holds the idempotency key AND the operation's effects (the services it calls
    // join it), so the key exists exactly when the effects committed. A repeat — a reply lost in
    // transit, a retry after a crash, two copies arriving together — is answered from the key and
    // does nothing; a rolled-back operation leaves no key and runs fresh next time.
    return await runInTransactionScope(async (tx): Promise<OperationResult> => {
      const claim = await claimOperationKey(tx, {
        opId: op.opId,
        deviceId: auth.deviceId,
        userId: auth.userId,
        type: op.type,
        hash: payloadHash(op.type, op.payload),
      });

      if (claim.kind === 'replay') {
        const id = claim.result.id;
        // The row's version NOW, not the one the first call saw, so a device that stamps it never
        // masks a newer edit.
        const serverSeq =
          seqTable && id ? await syncRepository.serverSeqOf(tx, seqTable, id) : undefined;
        return {
          ...base,
          status: 'replayed',
          ...(id !== undefined ? { id } : {}),
          ...(serverSeq !== undefined ? { serverSeq } : {}),
          ...(claim.result.warnings && claim.result.warnings.length > 0
            ? { warnings: claim.result.warnings }
            : {}),
          ...(claim.result.mergedInto ? { mergedInto: claim.result.mergedInto as MergedInto } : {}),
        };
      }

      // An id this business already merged into another record means that record from now on, so
      // what a phone queued against its own duplicate (bills, payments, edits) lands on the one
      // real record. The create that caused the merge is always earlier in that phone's outbox.
      const originalId = (payload as { id?: string }).id;
      let work = (batch.aliasesPossible ? await resolveAliases(tx, payload) : payload);
      const workId = (work).id;

      // Two phones added the same customer, supplier, item or category: match this create to the
      // record that exists rather than refusing it (see merge.ts).
      const mergeEntity = mergeEntityOf(op.type);
      if (mergeEntity && table) {
        const aliasedSelf = originalId !== undefined && workId !== originalId;
        let canonicalId: string | undefined = aliasedSelf ? workId : undefined;
        if (canonicalId === undefined && !(await probe(tx, table, workId)).exists) {
          canonicalId = await findMergeTarget(tx, mergeEntity, work);
          if (canonicalId !== undefined) {
            await recordAlias(tx, mergeEntity, workId, canonicalId, auth.deviceId);
            batch.aliasesPossible = true;
          }
        }
        if (canonicalId !== undefined) {
          const mergedInto: MergedInto = {
            entity: mergeEntity,
            aliasId: originalId ?? workId,
            canonicalId,
          };
          // A balance carried by the duplicate is not added to the existing record's: it would be
          // counted twice. Said out loud, so the shop can enter it by hand if it was real.
          const warnings = (work as { openingBalance?: number }).openingBalance
            ? [{ code: WarningCode.OPENING_BALANCE_IGNORED, details: { entity: mergeEntity } }]
            : undefined;
          const serverSeq = await syncRepository.serverSeqOf(tx, table, canonicalId);
          await completeOperationKey(tx, op.opId, {
            id: canonicalId,
            mergedInto,
            ...(warnings ? { warnings } : {}),
          });
          return {
            ...base,
            status: 'applied',
            id: canonicalId,
            ...(serverSeq !== undefined ? { serverSeq } : {}),
            mergedInto,
            ...(warnings ? { warnings } : {}),
          };
        }
      }

      // An edit that says what each field was merges field by field; one that does not (an older
      // build) is held to the whole-row version check below.
      let conflicts: FieldMerge['conflicts'] = [];
      const fieldMerge = FIELD_MERGE_TABLES[op.type];
      const patch = (work as { patch?: unknown }).patch;
      const was = (work as { was?: unknown }).was;
      const mergesFields =
        fieldMerge !== undefined &&
        typeof patch === 'object' &&
        patch !== null &&
        typeof was === 'object' &&
        was !== null;
      if (mergesFields) {
        const merged = await mergeUpdate(
          tx,
          fieldMerge.table,
          workId,
          patch as Record<string, unknown>,
          was as Record<string, unknown>,
        );
        work = { ...work, patch: merged.patch } as typeof payload;
        conflicts = merged.conflicts;
      }

      // Stale-write and replay checks happen before dispatch so the answer is explicit; the
      // services themselves also tolerate a replay (the fallback once a key has expired).
      let replayedByProbe = false;
      if (table) {
        const before = await probe(tx, table, workId);
        const isCreate = op.type.endsWith('.create') || op.type === 'stock.adjust';
        if (isCreate && before.exists) replayedByProbe = true;
        if (
          !isCreate &&
          !mergesFields &&
          op.baseServerSeq !== undefined &&
          before.serverSeq !== undefined
        ) {
          if (before.serverSeq > op.baseServerSeq) {
            throw new ConflictError(
              'This record was changed elsewhere after the device last saw it.',
              ErrorCode.STALE_WRITE,
              { details: { currentServerSeq: before.serverSeq, baseServerSeq: op.baseServerSeq } },
            );
          }
        }
      }

      const applied = await dispatch(op.type, work);
      const replayed = replayedByProbe || applied.replayed === true;
      const serverSeq = seqTable
        ? await syncRepository.serverSeqOf(tx, seqTable, applied.id)
        : undefined;

      if (fieldMerge && conflicts.length > 0) {
        await recordConflicts(tx, fieldMerge.entityType, applied.id, conflicts);
      }
      const allWarnings = [
        ...(applied.warnings ?? []),
        ...(conflicts.length > 0
          ? [{ code: WarningCode.FIELD_CONFLICT, details: { fields: conflicts.map((c) => c.field) } }]
          : []),
      ];
      const warnings = allWarnings.length > 0 ? allWarnings : undefined;

      await completeOperationKey(tx, op.opId, {
        id: applied.id,
        ...(warnings ? { warnings } : {}),
      });

      return {
        ...base,
        status: replayed ? 'replayed' : 'applied',
        id: applied.id,
        ...(serverSeq !== undefined ? { serverSeq } : {}),
        ...(warnings ? { warnings } : {}),
      };
    });
  } catch (error) {
    return rejected(error);
  }
}

/**
 * Forgets expired idempotency keys, a few hundred at a time, on roughly one push in twenty.
 * There is no scheduler in this service, and the keys are tiny, so a probabilistic sweep from
 * the path that creates them is enough. Failure is only logged: it must never fail a push.
 */
async function sweepExpiredKeys(): Promise<void> {
  if (Math.random() >= 0.05) return;
  try {
    const removed = await purgeExpiredKeys();
    if (removed > 0) log.info({ removed }, 'Expired operation keys purged');
  } catch (error) {
    log.warn({ err: error }, 'Could not purge expired operation keys');
  }
}

export async function pushOperations(body: PushBody): Promise<PushResult> {
  const auth = requireAuthContext();
  const startedAt = new Date();

  if (body.operations.length > env.SYNC_PUSH_MAX_OPERATIONS) {
    throw new AppError(
      413,
      ErrorCode.SYNC_BATCH_TOO_LARGE,
      `A push may carry at most ${env.SYNC_PUSH_MAX_OPERATIONS} operations.`,
      { details: { max: env.SYNC_PUSH_MAX_OPERATIONS, received: body.operations.length } },
    );
  }

  const batchState: PushBatchState = {
    aliasesPossible: await withReadTransaction((tx) => tenantHasAliases(tx)),
  };
  const results: OperationResult[] = [];
  // Sequential on purpose: a device's outbox is ordered, and a later operation
  // may depend on an earlier one (a receipt against an invoice in the same batch).
  for (const op of body.operations) {
    const result = await runOperation(op, auth.role, batchState);
    syncOperations.inc({ type: op.type, result: result.status });
    results.push(result);
  }

  const counts = { applied: 0, replayed: 0, rejected: 0 };
  for (const r of results) counts[r.status] += 1;

  await withTransaction(async (tx) => {
    await syncRepository.markPushed(tx, auth.deviceId);
    await syncRepository.insertBatch(tx, {
      id: newId(),
      deviceId: auth.deviceId,
      kind: 'push',
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      operations: body.operations.length,
      ...counts,
      requestId: getContext()?.requestId,
    });
  });

  await sweepExpiredKeys();

  log.info({ deviceId: auth.deviceId, ...counts }, 'Sync push processed');
  return { results, serverTime: new Date().toISOString() };
}
