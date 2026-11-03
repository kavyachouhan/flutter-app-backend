/**
 * The only sanctioned path to the database.
 *
 * RLS policies compare against `app.current_tenant_id()`, which is NULL when
 * the setting is absent — so an unscoped query quietly returns no rows instead
 * of failing. That invites someone to "fix" it by loosening a policy. Every
 * entry point here therefore sets the context itself.
 *
 * SET LOCAL (via set_config(..., true)) rather than SET: on a transaction-mode
 * pooler a session setting would survive onto the next tenant's transaction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import { pool } from './pool.js';
import { getContext, requireTenantId } from '../lib/context.js';
import { createLogger } from '../lib/logger.js';
import { ConflictError, ErrorCode, InternalError } from '../lib/errors.js';

const log = createLogger('db:tx');

export interface Tx {
  readonly tenantId: string | null;
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  one<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R | undefined>;
  many<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
}

function wrap(client: PoolClient, tenantId: string | null): Tx {
  // pg types its parameter list as mutable, so the readonly array is copied.
  const run = <R extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> => client.query<R>(sql, params ? [...params] : undefined);
  return {
    tenantId,
    query: run,
    async one<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<R | undefined> {
      return (await run<R>(sql, params)).rows[0];
    },
    async many<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<R[]> {
      return (await run<R>(sql, params)).rows;
    },
  };
}

interface PostgresError extends Error {
  code: string;
  constraint?: string;
  table?: string;
}

function isPostgresError(error: unknown): error is PostgresError {
  return error instanceof Error && typeof (error as Partial<PostgresError>).code === 'string';
}

const RETRYABLE = new Set(['40001', '40P01']);

/** Maps the SQLSTATEs our schema deliberately raises onto domain errors. */
export function translatePostgresError(error: unknown): unknown {
  if (!isPostgresError(error)) return error;

  switch (error.code) {
    case '23505':
      return new ConflictError('That record already exists.', ErrorCode.DUPLICATE, {
        cause: error,
        details: { constraint: error.constraint },
      });
    case '23P01':
      return new ConflictError('The request overlaps an existing record.', ErrorCode.CONFLICT, {
        cause: error,
        details: { constraint: error.constraint },
      });
    // Raised by the immutability and append-only triggers.
    case '23001':
      return new ConflictError(error.message, ErrorCode.DOCUMENT_IMMUTABLE, { cause: error });
    case '40001':
    case '40P01':
      return new ConflictError(
        'The request conflicted with another operation. Please retry.',
        ErrorCode.CONFLICT,
        {
          cause: error,
          retryAfterSeconds: 1,
        },
      );
    // Validation happens before SQL, so these indicate a bug, not bad input.
    case '23503':
    case '23514':
    case '23502':
      return new InternalError('A database constraint was violated.', { cause: error });
    default:
      return error;
  }
}

export type IsolationLevel = 'read_committed' | 'repeatable_read';

async function begin(
  client: PoolClient,
  tenantId: string | null,
  readOnly: boolean,
  isolation: IsolationLevel = 'read_committed',
): Promise<void> {
  // A multi-statement pull under READ COMMITTED takes a new snapshot per
  // statement, so a row committed between two statements can be skipped
  // permanently by a cursor that has already moved past its server_seq.
  const level = isolation === 'repeatable_read' ? ' ISOLATION LEVEL REPEATABLE READ' : '';
  await client.query(`BEGIN${level}${readOnly ? ' READ ONLY' : ''}`);
  await client.query(
    `SELECT set_config('app.tenant_id', $1, true),
            set_config('app.user_id', $2, true),
            set_config('statement_timeout', $3, true),
            set_config('idle_in_transaction_session_timeout', $4, true)`,
    [
      tenantId ?? '',
      getContext()?.userId ?? '',
      String(env.DATABASE_STATEMENT_TIMEOUT_MS),
      String(env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS),
    ],
  );
}

export interface TransactionOptions {
  /** For flows that act on a tenant before a tenant token exists (onboarding, session creation). */
  tenantId?: string;
  readOnly?: boolean;
  /** Set to 0 when the callback has side effects outside the database. */
  retries?: number;
  /** REPEATABLE READ gives every statement in the callback one snapshot. */
  isolation?: IsolationLevel;
}

/**
 * The transaction opened by [runInTransactionScope], while its callback is running.
 *
 * A pushed operation must record its idempotency key in the SAME transaction as its effects, but
 * the services it calls each open their own. Inside a scope those calls join the open transaction
 * instead, each behind a savepoint, so a service that fails still undoes only its own writes —
 * exactly as it did when it had a transaction to itself — while the whole operation commits or
 * rolls back as one.
 */
const scope = new AsyncLocalStorage<{ tx: Tx }>();
let savepointCounter = 0;

async function joinTransaction<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const name = `join_${++savepointCounter}`;
  await tx.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn(tx);
    await tx.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
    // Rethrown untouched: the outer transaction translates it once, and a retryable SQLSTATE
    // must still look like one to its retry loop.
    throw error;
  }
}

export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const open = scope.getStore();
  if (open && (options.tenantId === undefined || options.tenantId === open.tx.tenantId)) {
    return joinTransaction(open.tx, fn);
  }
  const tenantId = options.tenantId ?? requireTenantId();
  const maxAttempts = (options.retries ?? env.DATABASE_TRANSACTION_MAX_RETRIES) + 1;

  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await begin(client, tenantId, options.readOnly ?? false, options.isolation);
      const result = await fn(wrap(client, tenantId));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isPostgresError(error) && RETRYABLE.has(error.code) && attempt < maxAttempts) {
        log.warn({ attempt, code: error.code }, 'Transaction conflict, retrying');
        // Jitter, so two transactions that deadlocked do not retry in lockstep.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * env.DATABASE_RETRY_BASE_DELAY_MS * attempt),
        );
        continue;
      }
      throw translatePostgresError(error);
    } finally {
      client.release();
    }
  }
}

/**
 * Runs [fn] in one transaction that every `withTransaction` / `withReadTransaction` call made
 * inside it (however deep) joins. A conflict (deadlock) restarts the whole callback, including
 * whatever it claimed first, so nothing is half-applied.
 */
export function runInTransactionScope<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return withTransaction((tx) => scope.run({ tx }, () => fn(tx)), options);
}

export function withReadTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: Omit<TransactionOptions, 'readOnly'> = {},
) {
  return withTransaction(fn, { ...options, readOnly: true, retries: 0 });
}

/**
 * No tenant context: RLS matches nothing on tenant tables. Only for
 * pre-authentication work, which goes through the SECURITY DEFINER functions
 * in the `app` schema.
 */
export async function withUnscopedTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await begin(client, null, false);
    const result = await fn(wrap(client, null));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translatePostgresError(error);
  } finally {
    client.release();
  }
}
