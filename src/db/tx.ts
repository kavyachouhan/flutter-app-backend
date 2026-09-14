/**
 * Transactions and tenant scoping.
 *
 * This is the only sanctioned way to reach the database. It exists to make one
 * mistake impossible: running a query without the tenant context set. RLS
 * policies compare `tenant_id = app.current_tenant_id()`, and that function
 * returns NULL when the context is missing — so an unscoped query silently
 * returns zero rows rather than erroring. A developer then "fixes" the empty
 * result by loosening the policy, and tenant isolation is gone.
 *
 * Every entry point here sets the context explicitly, or is named loudly
 * enough that skipping it is a deliberate, reviewable act.
 *
 * SET LOCAL, never SET: the Supabase pooler runs pgbouncer in transaction
 * mode, so a connection is only ours for the duration of a transaction. A
 * session-scoped SET would persist onto the next checkout and leak one
 * tenant's context into another tenant's query.
 */
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { pool } from './pool.js';
import { getContext, requireTenantId } from '../lib/context.js';
import { createLogger } from '../lib/logger.js';
import { ConflictError, ErrorCode, InternalError } from '../lib/errors.js';

const log = createLogger('db:tx');

/**
 * The handle passed to a transaction callback.
 *
 * Deliberately not the raw `PoolClient`: exposing that would let a callback
 * issue its own COMMIT/ROLLBACK and desynchronise the wrapper's state.
 */
export interface Tx {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;

  /** First row, or undefined. The common "fetch by id" shape. */
  one<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R | undefined>;

  /** All rows. */
  many<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;

  /** The tenant this transaction is scoped to, or null for admin work. */
  readonly tenantId: string | null;
}

function wrapClient(client: PoolClient, tenantId: string | null): Tx {
  return {
    tenantId,
    // `pg` types its parameter array as a mutable `I`, so the readonly array
    // is copied rather than asserted — a copy of a handful of scalars costs
    // nothing and keeps the public signature honestly readonly.
    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      return client.query<R>(sql, params ? [...params] : undefined);
    },
    async one<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<R | undefined> {
      const result = await client.query<R>(sql, params ? [...params] : undefined);
      return result.rows[0];
    },
    async many<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<R[]> {
      const result = await client.query<R>(sql, params ? [...params] : undefined);
      return result.rows;
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres error translation
// ---------------------------------------------------------------------------

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

function isPostgresError(error: unknown): error is PostgresError {
  return error instanceof Error && typeof (error as PostgresError).code === 'string';
}

/**
 * Turns the Postgres error codes we deliberately provoke into domain errors.
 *
 * Everything the schema enforces — unique invoice numbers, the invoice
 * immutability trigger, the append-only ledger guard — surfaces here as a
 * raw SQLSTATE. Translating them once, centrally, is what lets a service
 * layer rely on constraints instead of racing a read-then-write check.
 */
export function translatePostgresError(error: unknown): unknown {
  if (!isPostgresError(error)) return error;

  switch (error.code) {
    // unique_violation
    case '23505':
      return new ConflictError('That record already exists.', ErrorCode.DUPLICATE, {
        cause: error,
        details: { constraint: error.constraint },
      });

    // restrict_violation — raised by the immutability and append-only triggers.
    case '23001':
      return new ConflictError(
        error.message.replace(/^.*?ERROR:\s*/i, ''),
        ErrorCode.DOCUMENT_IMMUTABLE,
        { cause: error },
      );

    // serialization_failure / deadlock_detected. Both are genuinely retryable,
    // which is why withTransaction retries them automatically.
    case '40001':
    case '40P01':
      return new ConflictError(
        'The request conflicted with another operation. Please retry.',
        ErrorCode.CONFLICT,
        { cause: error, retryAfterSeconds: 1 },
      );

    // foreign_key_violation, check_violation, not_null_violation. These are
    // programming errors rather than user errors — the API layer validates
    // before it gets here — so they surface as 500s with full detail logged.
    case '23503':
    case '23514':
    case '23502':
      return new InternalError('A database constraint was violated.', {
        cause: error,
        details: { constraint: error.constraint, table: error.table },
      });

    default:
      return error;
  }
}

// ---------------------------------------------------------------------------
// Transaction entry points
// ---------------------------------------------------------------------------

export interface TransactionOptions {
  /**
   * Override the tenant from the request context. Only for background jobs
   * that legitimately act on a tenant with no HTTP request in flight.
   */
  tenantId?: string;

  /**
   * Retries on serialization failure and deadlock. Safe by default because
   * the whole transaction is replayed from the start; set to 0 for work that
   * is not idempotent outside the database (sending an SMS, charging a card).
   */
  retries?: number;

  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

  /** Marks the transaction read-only, letting Postgres skip some bookkeeping. */
  readOnly?: boolean;
}

/**
 * Runs `fn` inside a transaction scoped to the current tenant.
 *
 * The tenant comes from the request context, so callers cannot pass the wrong
 * one and cannot forget to pass one at all. `app.user_id` is set alongside it
 * so database-side audit triggers can attribute a change without the
 * application threading the actor through every call.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const tenantId = options.tenantId ?? requireTenantId();
  const userId = getContext()?.userId ?? null;
  const maxAttempts = (options.retries ?? 2) + 1;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();

    try {
      const isolation = options.isolationLevel ?? 'READ COMMITTED';
      await client.query(
        `BEGIN ISOLATION LEVEL ${isolation}${options.readOnly ? ' READ ONLY' : ''}`,
      );

      // The tenant context. Parameterised rather than interpolated: even
      // though this value comes from a verified JWT and not from user input,
      // string-building SQL around an identity value is exactly the habit
      // that eventually produces an injection.
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      if (userId) {
        await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
      }

      const result = await fn(wrapClient(client, tenantId));

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);

      const translated = translatePostgresError(error);
      lastError = translated;

      const retryable =
        isPostgresError(error) && (error.code === '40001' || error.code === '40P01');

      if (retryable && attempt < maxAttempts) {
        // Full jitter. Without randomness, two transactions that deadlocked
        // together back off by the same amount and deadlock again.
        const backoffMs = Math.random() * 50 * attempt;
        log.warn({ attempt, maxAttempts, code: error.code }, 'Transaction conflict — retrying');
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      throw translated;
    } finally {
      client.release();
    }
  }

  throw lastError;
}

/**
 * A read-only transaction. Same tenant scoping, no retries needed, and
 * Postgres can take cheaper locks.
 */
export async function withReadTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: Omit<TransactionOptions, 'readOnly' | 'retries'> = {},
): Promise<T> {
  return withTransaction(fn, { ...options, readOnly: true, retries: 0 });
}

/**
 * Runs `fn` with NO tenant context, so RLS matches nothing on tenant-scoped
 * tables.
 *
 * The long name is the point: this appears in a diff and invites the question
 * "why does this not need a tenant?". The only legitimate uses are
 * pre-authentication work (looking up a user by phone, validating a refresh
 * token) and cross-tenant platform maintenance, both of which go through
 * explicitly-audited SECURITY DEFINER functions.
 */
export async function withUnscopedTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(wrapClient(client, null));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translatePostgresError(error);
  } finally {
    client.release();
  }
}

/**
 * A single tenant-scoped query without an explicit transaction block.
 *
 * Still a transaction underneath — it must be, because SET LOCAL only has
 * meaning inside one. This is a convenience for simple reads, not an escape
 * hatch from transactional behaviour.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
): Promise<R[]> {
  return withReadTransaction((tx) => tx.many<R>(sql, params));
}
