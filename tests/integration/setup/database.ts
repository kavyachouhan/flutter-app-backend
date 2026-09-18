/**
 * Owner-role access for the test harness.
 *
 * Tests themselves go through the API, which connects as the unprivileged app
 * role — that is the whole point, since RLS only proves anything against a
 * role that cannot bypass it. This module is the deliberate exception: only
 * setup and teardown use the owner connection, to truncate and to inspect
 * catalog state the API does not expose.
 */
import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { integrationEnv } from './env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/db/migrations/', import.meta.url));

let client: pg.Client | undefined;

export async function ownerClient(): Promise<pg.Client> {
  if (!client) {
    client = new pg.Client({
      connectionString: integrationEnv.migrationUrl,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
  }
  return client;
}

export async function closeOwnerClient(): Promise<void> {
  await client?.end();
  client = undefined;
}

/**
 * The harness never applies migrations itself: migrate.ts is a CLI that exits
 * the process, and a test run silently mutating schema is its own hazard.
 * Failing loudly with the command to run is better than either.
 */
export async function assertSchemaReady(): Promise<void> {
  const c = await ownerClient();
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
  const expected = files
    .map((f) => /^(\d+)_/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined);

  const ledgerExists = await c.query<{ present: boolean }>(
    "SELECT to_regclass('app.schema_migrations') IS NOT NULL AS present",
  );
  if (!ledgerExists.rows[0]?.present) {
    throw new Error('No schema in the test database. Run: npm run migrate');
  }

  const { rows } = await c.query<{ version: string }>('SELECT version FROM app.schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  const missing = expected.filter((v) => !applied.has(v));
  if (missing.length > 0) {
    throw new Error(
      `Test database is behind: migrations ${missing.join(', ')} are not applied.\n` +
        'Run: npm run migrate',
    );
  }

  const role = await c.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
    [integrationEnv.appRoleName],
  );
  if (role.rowCount === 0) {
    throw new Error(`Role ${integrationEnv.appRoleName} does not exist. Run: npm run db:bootstrap`);
  }
  // A test suite that proves isolation while connected as a bypassing role
  // proves nothing at all, so this is checked rather than assumed.
  if (role.rows[0]?.rolbypassrls || role.rows[0]?.rolsuper) {
    throw new Error(
      `Role ${integrationEnv.appRoleName} bypasses RLS; isolation tests would pass falsely.`,
    );
  }
}

/**
 * Wipes every tenant table. app.schema_migrations is left alone (it is the
 * schema, not data); app.tenant_sync_counters is reset so server_seq starts
 * from a known point in every file.
 */
export async function truncateAll(): Promise<void> {
  const c = await ownerClient();
  const { rows } = await c.query<{ list: string | null }>(
    `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS list
     FROM pg_tables WHERE schemaname = 'public'`,
  );
  const list = rows[0]?.list;
  if (list) await c.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await c.query('TRUNCATE app.tenant_sync_counters');
}
