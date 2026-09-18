/**
 * Connection pool to Supabase's transaction-mode pooler (Supavisor).
 *
 * In transaction mode a server connection is ours only for one transaction,
 * so no session state may be relied on: timeouts and tenant context are set
 * per transaction with SET LOCAL in tx.ts, not on connect.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { describeError } from '../lib/errors.js';
import { databaseSslConfig } from './ssl.js';

const log = createLogger('db');

const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082 } as const;

// BIGINT holds paise and sequence numbers. pg returns it as a string to avoid
// precision loss; we convert, but refuse rather than return an imprecise value.
pg.types.setTypeParser(OID.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`BIGINT ${value} exceeds the safe integer range.`);
  }
  return parsed;
});

// NUMERIC is only used for tax percentages, never for money.
pg.types.setTypeParser(OID.NUMERIC, (value: string) => Number(value));

// Calendar dates stay 'YYYY-MM-DD'. A JS Date would shift across the server's
// timezone and can move an invoice into the previous financial year.
pg.types.setTypeParser(OID.DATE, (value: string) => value);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: databaseSslConfig(),
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
  application_name: env.SERVICE_NAME,
});

// An error on an idle client (pooler restart, network drop) is emitted on the
// pool; unhandled, it would crash the process. pg replaces the client itself.
pool.on('error', (error) => {
  log.error({ err: error }, 'Idle database client error');
});

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function checkDatabaseHealth(): Promise<DbHealth> {
  const startedAt = performance.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: describeError(error),
    };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
