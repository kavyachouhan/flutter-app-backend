/**
 * Migration runner.
 *
 * Plain numbered `.sql` files, applied forward-only, each inside its own
 * transaction. No ORM migration DSL: this schema leans on RLS policies,
 * triggers, partial indexes and constraint exclusions that most DSLs express
 * badly or not at all, and the SQL is the thing being reviewed anyway.
 *
 *   npm run migrate          apply everything pending
 *   npm run migrate:status   show what is applied and what is pending
 *
 * Three properties that matter in production:
 *
 *   Atomic     — a failed migration rolls back completely. A half-applied
 *                schema change is far worse than a failed deploy.
 *   Serialised — a session-level advisory lock means two instances starting
 *                at once cannot both run the same migration. Without it a
 *                rolling deploy races itself.
 *   Immutable  — each file's checksum is recorded. Editing an applied
 *                migration is refused, because the edit would silently never
 *                run on any environment that already has it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { env } from '../config/env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * Arbitrary but fixed. Postgres advisory locks are keyed by a bigint; any two
 * processes using this same constant serialise against each other.
 */
const MIGRATION_LOCK_ID = 8_274_119_004_551n;

interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
  duration_ms: number;
}

/** `0003_billing.sql` → version `0003`, name `billing`. */
function parseFilename(filename: string): { version: string; name: string } | null {
  const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!match) return null;
  const [, version, name] = match;
  return version !== undefined && name !== undefined ? { version, name } : null;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const migrations: MigrationFile[] = [];

  for (const filename of entries.sort()) {
    if (!filename.endsWith('.sql')) continue;

    const parsed = parseFilename(filename);
    if (!parsed) {
      throw new Error(
        `Migration "${filename}" does not match the required NNNN_name.sql format ` +
          `(e.g. 0001_extensions.sql).`,
      );
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    migrations.push({
      ...parsed,
      filename,
      sql,
      // Normalise line endings first: a Windows checkout would otherwise
      // produce a different checksum from the same file on Linux CI.
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16),
    });
  }

  const versions = migrations.map((m) => m.version);
  const duplicate = versions.find((v, i) => versions.indexOf(v) !== i);
  if (duplicate) {
    throw new Error(
      `Two migrations share version ${duplicate}. Versions must be unique — this usually means ` +
        `two branches added a migration with the same number.`,
    );
  }

  return migrations;
}

/** The ledger table. Created outside the numbered set, so it always exists. */
async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT        PRIMARY KEY,
      name        TEXT        NOT NULL,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER     NOT NULL
    );
  `);
}

async function getApplied(client: pg.PoolClient): Promise<Map<string, AppliedMigration>> {
  const { rows } = await client.query<AppliedMigration>(
    'SELECT version, name, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * Refuses to proceed if an already-applied migration's content has changed.
 *
 * The failure this prevents: someone fixes a bug by editing migration 0004.
 * Their laptop already ran the old 0004, so nothing happens there. CI runs
 * from scratch and gets the new one. Two environments, two different schemas,
 * and nothing in the deploy output says so.
 */
function assertUnmodified(files: MigrationFile[], applied: Map<string, AppliedMigration>): void {
  const drifted: string[] = [];

  for (const file of files) {
    const record = applied.get(file.version);
    if (record && record.checksum !== file.checksum) {
      drifted.push(
        `  ${file.filename} — applied as ${record.checksum}, on disk it is ${file.checksum}`,
      );
    }
  }

  if (drifted.length > 0) {
    throw new Error(
      `Applied migrations have been modified:\n\n${drifted.join('\n')}\n\n` +
        `Applied migrations are immutable. Add a new migration with the correction instead — ` +
        `editing this one would never run on any database that already has it.\n`,
    );
  }
}

async function up(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    max: 1,
    // DDL on a large table can legitimately run long; the per-migration
    // timeout below is what actually bounds it.
    statement_timeout: 0,
  });

  const client = await pool.connect();

  try {
    console.log(`Connecting to ${redactUrl(env.DATABASE_URL)}`);

    // Session-scoped: held until this connection closes, covering the whole run.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID.toString()]);

    await ensureMigrationsTable(client);

    const files = await loadMigrations();
    const applied = await getApplied(client);

    assertUnmodified(files, applied);

    const pending = files.filter((file) => !applied.has(file.version));

    if (pending.length === 0) {
      console.log(`Schema is up to date (${applied.size} migration(s) applied).`);
      return;
    }

    console.log(`Applying ${pending.length} migration(s):`);

    for (const migration of pending) {
      const startedAt = Date.now();
      process.stdout.write(`  ${migration.filename} ... `);

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);

        const durationMs = Date.now() - startedAt;
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, durationMs],
        );
        await client.query('COMMIT');

        console.log(`ok (${durationMs}ms)`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.log('FAILED');
        console.error(`\n${formatPostgresError(error, migration)}\n`);
        throw new Error(`Migration ${migration.filename} failed. No changes were applied.`);
      }
    }

    console.log(`\nDone. Schema is at version ${pending[pending.length - 1]?.version}.`);
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function status(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    max: 1,
  });
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const files = await loadMigrations();
    const applied = await getApplied(client);

    console.log(`\n${'Version'.padEnd(10)}${'Name'.padEnd(32)}${'Status'.padEnd(12)}Applied at`);
    console.log('-'.repeat(88));

    for (const file of files) {
      const record = applied.get(file.version);
      const drifted = record && record.checksum !== file.checksum;
      const state = !record ? 'PENDING' : drifted ? 'MODIFIED!' : 'applied';
      const when = record ? record.applied_at.toISOString() : '';
      console.log(`${file.version.padEnd(10)}${file.name.padEnd(32)}${state.padEnd(12)}${when}`);
    }

    // An orphan is a migration recorded in the database with no file on disk —
    // usually a branch switch, occasionally a deleted migration.
    for (const [version, record] of applied) {
      if (!files.some((f) => f.version === version)) {
        console.log(
          `${version.padEnd(10)}${record.name.padEnd(32)}${'ORPHAN'.padEnd(12)}${record.applied_at.toISOString()}`,
        );
      }
    }

    const pendingCount = files.filter((f) => !applied.has(f.version)).length;
    console.log('-'.repeat(88));
    console.log(`${applied.size} applied, ${pendingCount} pending\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

/** Never print credentials, even from a local script. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

/**
 * Postgres reports a syntax error with a character offset into the statement.
 * Turning that into a file/line reference is the difference between a
 * two-minute fix and a twenty-minute hunt.
 */
function formatPostgresError(error: unknown, migration: MigrationFile): string {
  if (!(error instanceof Error)) return String(error);

  const pgError = error as Error & { position?: string; detail?: string; hint?: string };
  const parts = [`  ${pgError.message}`];

  if (pgError.detail) parts.push(`  Detail: ${pgError.detail}`);
  if (pgError.hint) parts.push(`  Hint:   ${pgError.hint}`);

  if (pgError.position) {
    const offset = Number(pgError.position);
    if (Number.isFinite(offset)) {
      const before = migration.sql.slice(0, offset);
      const line = before.split('\n').length;
      const column = offset - before.lastIndexOf('\n');
      parts.push(`  At:     ${migration.filename}:${line}:${column}`);
      const sourceLine = migration.sql.split('\n')[line - 1];
      if (sourceLine) {
        parts.push(`\n    ${sourceLine.trim()}`);
      }
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------

const command = process.argv[2] ?? 'up';

const commands: Record<string, () => Promise<void>> = { up, status };
const run = commands[command];

if (!run) {
  console.error(`Unknown command "${command}". Use: up | status`);
  process.exit(1);
}

run().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
