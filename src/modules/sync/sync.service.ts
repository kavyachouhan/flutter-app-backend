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
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { getContext, requireAuthContext } from '../../lib/context.js';
import {
  AppError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  ValidationError,
  isAppError,
  type ErrorCodeValue,
} from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { createLogger } from '../../lib/logger.js';
import { syncOperations, syncPullChanges } from '../../observability/metrics.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import * as catalogueService from '../catalogue/catalogue.service.js';
import * as creditNotesService from '../credit-notes/credit-notes.service.js';
import * as customersService from '../customers/customers.service.js';
import * as invoicesService from '../invoices/invoices.service.js';
import type { BlockRow } from '../numbering/numbering.repository.js';
import { topUpLeasesForDevice } from '../numbering/numbering.service.js';
import * as paymentsService from '../payments/payments.service.js';
import * as stockService from '../stock/stock.service.js';
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
  'credit_note.printed': 'credit_notes:read',
  'payment.create': 'payments:create',
  'payment.void': 'payments:void',
  'customer.create': 'customers:write',
  'customer.update': 'customers:write',
  'item.create': 'catalogue:write',
  'item.update': 'catalogue:write',
  'category.create': 'catalogue:write',
  'category.update': 'catalogue:write',
  'stock.adjust': 'stock:adjust',
};

/** Table a create/update touches, for replay detection and stale-write checks. */
const OPERATION_TABLE: Partial<Record<OperationType, string>> = {
  'payment.create': 'payments',
  'customer.create': 'customers',
  'customer.update': 'customers',
  'item.create': 'items',
  'item.update': 'items',
  'category.create': 'categories',
  'category.update': 'categories',
  'stock.adjust': 'stock_ledger_entries',
};

type Payload<T extends OperationType> = (typeof OPERATION_PAYLOADS)[T]['_output'];

interface Applied {
  id: string;
  replayed?: boolean;
  warnings?: unknown[];
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
    case 'stock.adjust': {
      const p = payload as Payload<'stock.adjust'>;
      await stockService.createAdjustment(p);
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

async function runOperation(
  op: PushOperation,
  role: Parameters<typeof hasPermission>[0],
): Promise<OperationResult> {
  const base: Pick<OperationResult, 'opId' | 'type'> = { opId: op.opId, type: op.type };

  const rejected = (error: unknown): OperationResult => {
    const appError = isAppError(error)
      ? error
      : new AppError(500, ErrorCode.INTERNAL, 'An unexpected error occurred.', { cause: error });
    if (!isAppError(error))
      log.error({ err: error, opId: op.opId, type: op.type }, 'Sync op crashed');
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

  try {
    // Replay and stale-write checks happen before dispatch so the answer is
    // explicit; the services themselves also tolerate a replay.
    let replayedByProbe = false;
    if (table) {
      const before = await withReadTransaction((tx) => probe(tx, table, payload.id));
      const isCreate = op.type.endsWith('.create') || op.type === 'stock.adjust';
      if (isCreate && before.exists) replayedByProbe = true;
      if (!isCreate && op.baseServerSeq !== undefined && before.serverSeq !== undefined) {
        if (before.serverSeq > op.baseServerSeq) {
          throw new ConflictError(
            'This record was changed elsewhere after the device last saw it.',
            ErrorCode.STALE_WRITE,
            { details: { currentServerSeq: before.serverSeq, baseServerSeq: op.baseServerSeq } },
          );
        }
      }
    }

    const applied = await dispatch(op.type, payload);
    const replayed = replayedByProbe || applied.replayed === true;
    const seqTable =
      table ??
      (op.type.startsWith('invoice.')
        ? 'invoices'
        : op.type.startsWith('credit_note.')
          ? 'credit_notes'
          : undefined);
    const serverSeq = seqTable
      ? await withReadTransaction((tx) => syncRepository.serverSeqOf(tx, seqTable, applied.id))
      : undefined;

    return {
      ...base,
      status: replayed ? 'replayed' : 'applied',
      id: applied.id,
      ...(serverSeq !== undefined ? { serverSeq } : {}),
      ...(applied.warnings && applied.warnings.length > 0 ? { warnings: applied.warnings } : {}),
    };
  } catch (error) {
    return rejected(error);
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

  const results: OperationResult[] = [];
  // Sequential on purpose: a device's outbox is ordered, and a later operation
  // may depend on an earlier one (a receipt against an invoice in the same batch).
  for (const op of body.operations) {
    const result = await runOperation(op, auth.role);
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

  log.info({ deviceId: auth.deviceId, ...counts }, 'Sync push processed');
  return { results, serverTime: new Date().toISOString() };
}
