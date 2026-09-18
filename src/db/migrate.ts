/**
 * Forward-only SQL migrations, each in its own transaction.
 *
 *   up      apply pending migrations
 *   status  list applied / pending / modified
 *
 * Runs against DATABASE_MIGRATION_URL (owner role, session-mode or direct):
 * the advisory lock below is session-scoped, and a transaction-mode pooler
 * would release the connection — and with it the lock — between statements.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { migrationClientConfig } from './migration-client.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

// Any fixed key works; every migrate process must use the same one.
const MIGRATION_LOCK_KEY = 'khata.schema_migrations';

interface MigrationFile {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  version: string;
  checksum: string;
  applied_at: Date;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];

  for (const filename of files) {
    const version = /^(\d+)_[a-z0-9_]+\.sql$/.exec(filename)?.[1];
    if (!version) throw new Error(`Migration "${filename}" must be named <number>_<name>.sql`);
    if (migrations.some((m) => m.version === version)) {
      throw new Error(
        `Duplicate migration version ${version} — two branches picked the same number.`,
      );
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    // Line endings are normalised so a Windows checkout and Linux CI agree.
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    migrations.push({ version, filename, sql, checksum });
  }
  return migrations;
}

async function ensureLedger(client: pg.Client): Promise<Map<string, AppliedMigration>> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.schema_migrations (
      version    TEXT        PRIMARY KEY,
      filename   TEXT        NOT NULL,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  const { rows } = await client.query<AppliedMigration>(
    'SELECT version, checksum, applied_at FROM app.schema_migrations',
  );
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * An edited migration never re-runs where it was already applied, so two
 * environments silently diverge. Corrections must be new migrations.
 */
function assertUnmodified(files: MigrationFile[], applied: Map<string, AppliedMigration>): void {
  const modified = files.filter((f) => {
    const record = applied.get(f.version);
    return record !== undefined && record.checksum !== f.checksum;
  });
  if (modified.length > 0) {
    throw new Error(
      `Applied migrations were modified: ${modified.map((m) => m.filename).join(', ')}. ` +
        'Write a new migration instead.',
    );
  }
}

function describePgError(error: unknown, migration: MigrationFile): string {
  if (!(error instanceof Error)) return String(error);
  const pgError = error as Error & { position?: string; detail?: string; hint?: string };
  const lines = [pgError.message];
  if (pgError.detail) lines.push(`Detail: ${pgError.detail}`);
  if (pgError.hint) lines.push(`Hint: ${pgError.hint}`);
  const offset = Number(pgError.position);
  if (Number.isFinite(offset)) {
    lines.push(`At: ${migration.filename}:${migration.sql.slice(0, offset).split('\n').length}`);
  }
  return lines.join('\n');
}

async function up(client: pg.Client): Promise<void> {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
  try {
    const files = await loadMigrations();
    const applied = await ensureLedger(client);
    assertUnmodified(files, applied);

    const pending = files.filter((f) => !applied.has(f.version));
    if (pending.length === 0) {
      console.log(`Schema up to date (${applied.size} applied).`);
      return;
    }

    for (const migration of pending) {
      process.stdout.write(`${migration.filename} ... `);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO app.schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.filename, migration.checksum],
        );
        await client.query('COMMIT');
        console.log('ok');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.log('FAILED');
        throw new Error(
          `${describePgError(error, migration)}\nNo changes from this migration were applied.`,
        );
      }
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
  }
}

async function status(client: pg.Client): Promise<void> {
  const files = await loadMigrations();
  const applied = await ensureLedger(client);
  for (const file of files) {
    const record = applied.get(file.version);
    const state = !record ? 'pending' : record.checksum === file.checksum ? 'applied' : 'MODIFIED';
    console.log(
      `${state.padEnd(10)}${file.filename}${record ? `  ${record.applied_at.toISOString()}` : ''}`,
    );
  }
}

const commands: Record<string, (client: pg.Client) => Promise<void>> = { up, status };
const command = commands[process.argv[2] ?? ''];

if (!command) {
  console.error('Usage: migrate <up|status>');
  process.exit(1);
}

const client = new pg.Client(migrationClientConfig());
client
  .connect()
  .then(() => command(client))
  .then(() => client.end())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await client.end().catch(() => undefined);
    process.exit(1);
  });
