/**
 * The Postgres connection pool.
 *
 * Points at local Postgres in development and at the Supabase *pooler* in
 * production. Two consequences of the pooler worth knowing, because both have
 * bitten real deployments:
 *
 *   1. It runs pgbouncer in transaction mode, so a connection is only yours
 *      for the duration of a transaction. Session state does not persist —
 *      which is exactly why `SET LOCAL app.tenant_id` (transaction-scoped)
 *      is used for tenant context rather than `SET` (session-scoped).
 *   2. Prepared statements are not shared across checkouts, so `pg`'s default
 *      simple-query path is the right one. We do not enable named statements.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { describeError } from '../lib/errors.js';

const log = createLogger('db');

// ---------------------------------------------------------------------------
// Type parsers
//
// `pg` returns several numeric types as strings by default to avoid precision
// loss. We override the ones we rely on, with explicit safety checks — silent
// precision loss in a money column is precisely the failure this codebase is
// built to prevent.
// ---------------------------------------------------------------------------

const OID = {
  INT8: 20, // bigint — money (paise) and server_seq
  NUMERIC: 1700, // numeric — quantities and tax rates
  DATE: 1082, // date — financial-year and document dates
} as const;

/**
 * BIGINT → number, asserting it fits.
 *
 * Every BIGINT in this schema is either paise (bounded by ₹90 trillion) or a
 * sequence counter, both far inside 2^53. If one ever isn't, we want a crash
 * naming the value, not a quietly wrong total.
 */
pg.types.setTypeParser(OID.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `A BIGINT column returned ${value}, which exceeds JavaScript's safe integer range. ` +
        `Refusing to return an imprecise value.`,
    );
  }
  return parsed;
});

/**
 * NUMERIC → number.
 *
 * Safe here only because no NUMERIC column in this schema holds money —
 * amounts are BIGINT paise. NUMERIC is used for quantities and tax
 * percentages, where a double is exact enough at the scales involved.
 */
pg.types.setTypeParser(OID.NUMERIC, (value: string) => Number(value));

/**
 * DATE → the literal 'YYYY-MM-DD' string, NOT a Date.
 *
 * `pg` would otherwise build a Date at local midnight, so a server running in
 * UTC turns an invoice dated 2026-04-01 IST into 2026-03-31 — moving it into
 * the previous financial year on a GSTR-1 filing. Calendar dates have no
 * timezone and are kept as strings end to end.
 */
pg.types.setTypeParser(OID.DATE, (value: string) => value);

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,

  // Supabase terminates TLS at the pooler; `rejectUnauthorized: false` is
  // required because it presents a certificate for a shared hostname.
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,

  max: env.DATABASE_POOL_MAX,
  min: 0,

  // Release idle connections: the Supabase pooler has a global connection
  // budget shared with every other client of the project.
  idleTimeoutMillis: 30_000,

  // Fail fast when the database is unreachable rather than piling up requests
  // behind a checkout that will never complete.
  connectionTimeoutMillis: 10_000,

  // A runaway query must not hold a pooled connection indefinitely. Set per
  // connection below rather than in the URL so it survives pooler handoff.
  application_name: 'khata-api',
});

/**
 * Applied to every new physical connection.
 *
 * - `statement_timeout` caps any single query.
 * - `idle_in_transaction_session_timeout` kills a transaction left open by a
 *   crashed handler, which would otherwise hold locks and block writers.
 * - `TimeZone=UTC` makes timestamp handling deterministic regardless of where
 *   the container runs.
 */
pool.on('connect', (client) => {
  void client
    .query(
      `SET statement_timeout = ${env.DATABASE_STATEMENT_TIMEOUT_MS};
       SET idle_in_transaction_session_timeout = 30000;
       SET TimeZone = 'UTC';`,
    )
    .catch((error: unknown) => {
      log.error({ err: error }, 'Failed to apply session settings to a new connection');
    });
});

/**
 * Errors on *idle* pooled connections — a database restart, a pooler eviction,
 * a network blip. `pg` emits these on the pool rather than on a query, and an
 * unhandled 'error' event on an EventEmitter crashes the process. The pool
 * discards the broken connection itself; we only need to record it.
 */
pool.on('error', (error) => {
  log.error({ err: error }, 'Idle client error — the connection will be discarded and replaced');
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
  pool: { total: number; idle: number; waiting: number };
}

/** Used by /readyz. `SELECT 1` is cheap and exercises a real round-trip. */
export async function checkDatabaseHealth(): Promise<DbHealth> {
  const startedAt = performance.now();
  const stats = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };

  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt), pool: stats };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: describeError(error),
      pool: stats,
    };
  }
}

/** Called during graceful shutdown, after the HTTP server stops accepting. */
export async function closePool(): Promise<void> {
  await pool.end();
  log.info('Database pool closed');
}
