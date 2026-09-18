/**
 * Idempotent Supabase setup, run after `migrate`:
 *
 *   1. Creates or updates the LOGIN role the API connects as and adds it to
 *      the `app_runtime` group from migration 0001.
 *   2. Refuses to finish if that role can bypass RLS — every tenant boundary
 *      depends on it not being able to.
 *   3. Revokes Supabase's default grants to `anon` / `authenticated`. This API
 *      does not use the Supabase Data API, and those grants would otherwise be
 *      reachable with the project's public anon key.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { migrationClientConfig } from './migration-client.js';

// Roles behind the Supabase Data API; absent on plain Postgres.
const SUPABASE_API_ROLES = ['anon', 'authenticated'];

// format() with %I / %L quotes identifiers and literals server-side, so the
// role name and password are never concatenated into SQL. Parameters need an
// explicit ::text because format() is variadic and Postgres cannot infer them.
async function execFormatted(
  client: pg.Client,
  template: string,
  ...args: string[]
): Promise<void> {
  const argList = args.map((_, i) => `$${i + 2}::text`).join(', ');
  const { rows } = await client.query<{ sql: string }>(
    `SELECT format($1::text${argList ? `, ${argList}` : ''}) AS sql`,
    [template, ...args],
  );
  const sql = rows[0]?.sql;
  if (!sql) throw new Error('format() returned no statement');
  await client.query(sql);
}

async function bootstrap(client: pg.Client): Promise<void> {
  const roleName = env.DATABASE_APP_ROLE_NAME;
  const password = env.DATABASE_APP_ROLE_PASSWORD;
  if (!password) throw new Error('DATABASE_APP_ROLE_PASSWORD is required for bootstrap.');

  const group = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'");
  if (group.rowCount === 0) throw new Error('Role app_runtime is missing. Run `migrate` first.');

  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
  const verb = existing.rowCount === 0 ? 'CREATE' : 'ALTER';
  await execFormatted(client, `${verb} ROLE %I LOGIN INHERIT PASSWORD %L`, roleName, password);
  await execFormatted(client, 'GRANT app_runtime TO %I', roleName);
  await execFormatted(client, 'ALTER ROLE %I SET search_path = public, extensions', roleName);
  console.log(`${verb === 'CREATE' ? 'Created' : 'Updated'} role ${roleName}`);

  const { rows } = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
    [roleName],
  );
  if (rows[0]?.rolbypassrls || rows[0]?.rolsuper) {
    throw new Error(`Role ${roleName} bypasses RLS; tenant isolation would not hold.`);
  }

  const apiRoles = await client.query<{ rolname: string }>(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1)',
    [SUPABASE_API_ROLES],
  );
  for (const { rolname } of apiRoles.rows) {
    await execFormatted(client, 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', rolname);
    await execFormatted(client, 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', rolname);
    await execFormatted(client, 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', rolname);
    await execFormatted(client, 'REVOKE ALL ON SCHEMA app FROM %I', rolname);
    await execFormatted(
      client,
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
      rolname,
    );
    await execFormatted(
      client,
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
      rolname,
    );
    console.log(`Revoked Data API privileges from ${rolname}`);
  }
}

const client = new pg.Client(migrationClientConfig());
client
  .connect()
  .then(() => bootstrap(client))
  .then(() => client.end())
  .then(() => console.log('Bootstrap complete.'))
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await client.end().catch(() => undefined);
    process.exit(1);
  });
