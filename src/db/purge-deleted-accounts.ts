/**
 * Purges businesses whose owners deleted them in the app (account_deletions,
 * scope 'business'). Run by an operator or a nightly scheduler:
 *
 *   npm run purge:accounts                  list what is due, change nothing
 *   npm run purge:accounts -- --execute     delete it
 *   npm run purge:accounts -- --rehearse    do every delete, then roll back
 *
 * The Privacy Policy promises deletion within 30 days of the request, so this
 * must run at least that often; daily is the intent.
 *
 * How a business is deleted — one transaction per business, so it is all or
 * nothing:
 *
 * 1. Every table carrying a `tenant_id` column is found at run time, in the
 *    public and app schemas. Nothing is listed by hand: a table added by a
 *    later migration is purged without anyone remembering to add it here.
 * 2. Those tables' user triggers are switched off for the transaction. Bills,
 *    payments and ledgers are guarded against deletion by triggers — rightly,
 *    for the app — and the purge is the one sanctioned exception. Foreign keys
 *    are not triggers of that kind and stay on. The triggers are switched
 *    back on before commit, so no other session ever sees them off (the
 *    ALTERs hold their locks until commit).
 * 3. Rows are deleted table by table, retrying tables a foreign key held
 *    back, until nothing of the business is left. A pass with no progress
 *    rolls the whole business back and reports which tables are stuck.
 * 4. Members who belonged to no other business are deleted (or, if some
 *    other business's record still points at them, left erased).
 * 5. The tenant row goes last; the account_deletions row is marked purged.
 *
 * Stored files (logos, photos, attachments, imports) are deleted after the
 * commit — storage is not transactional, and a file left behind is a smaller
 * failure than records deleted without their files' owner being known.
 *
 * Needs the owner role (DATABASE_MIGRATION_URL): it bypasses row-level
 * security and owns the tables whose triggers it switches.
 */
import pg from 'pg';
import { removeAllForTenant } from '../lib/storage.js';
import { migrationClientConfig } from './migration-client.js';

type Mode = 'list' | 'execute' | 'rehearse';

/** Kept: the record that the deletion was asked for and done. Never purged. */
const KEEP_TABLES = new Set(['public.account_deletions']);

interface DueDeletion {
  id: string;
  tenantId: string;
  requestedAt: Date;
  purgeDueAt: Date;
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const qualified = (table: string) => table.split('.').map(quote).join('.');

async function tenantTables(client: pg.Client): Promise<string[]> {
  const rows = await client.query<{ t: string }>(
    `SELECT c.table_schema || '.' || c.table_name AS t
     FROM information_schema.columns c
     JOIN information_schema.tables tb
       ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
     WHERE c.column_name = 'tenant_id' AND c.table_schema IN ('public', 'app')
     ORDER BY 1`,
  );
  return rows.rows.map((r) => r.t).filter((t) => !KEEP_TABLES.has(t));
}

async function countRows(client: pg.Client, tables: readonly string[], tenantId: string) {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${qualified(table)} WHERE tenant_id = $1`,
      [tenantId],
    );
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) counts[table] = n;
  }
  return counts;
}

async function purgeTenant(client: pg.Client, tenantId: string, tables: readonly string[]) {
  const toggled = [...tables, 'public.tenants', 'public.account_deletions'];
  for (const table of toggled)
    await client.query(`ALTER TABLE ${qualified(table)} DISABLE TRIGGER USER`);

  // Who belongs here, read before memberships go.
  const memberRows = await client.query<{ userId: string }>(
    'SELECT DISTINCT user_id AS "userId" FROM public.memberships WHERE tenant_id = $1',
    [tenantId],
  );

  let remaining = [...tables];
  let deleted = 0;
  for (let pass = 1; remaining.length > 0; pass += 1) {
    const heldBack: string[] = [];
    let progress = 0;
    for (const table of remaining) {
      await client.query('SAVEPOINT purge_table');
      try {
        const r = await client.query(`DELETE FROM ${qualified(table)} WHERE tenant_id = $1`, [
          tenantId,
        ]);
        await client.query('RELEASE SAVEPOINT purge_table');
        deleted += r.rowCount ?? 0;
        progress += 1;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT purge_table');
        // 23503: another table's rows still point here. Try again next pass.
        if ((error as { code?: string }).code !== '23503') throw error;
        heldBack.push(table);
      }
    }
    if (heldBack.length > 0 && progress === 0) {
      throw new Error(`No progress on pass ${pass}; still referenced: ${heldBack.join(', ')}`);
    }
    remaining = heldBack;
  }

  // Members who belong to no other business: gone entirely if nothing else
  // points at them, otherwise left erased (the request already erased them).
  let usersDeleted = 0;
  for (const { userId } of memberRows.rows) {
    const other = await client.query(
      'SELECT 1 FROM public.memberships WHERE user_id = $1 AND tenant_id <> $2 AND deleted_at IS NULL LIMIT 1',
      [userId, tenantId],
    );
    if (other.rowCount) continue;
    await client.query('SAVEPOINT purge_user');
    try {
      await client.query('DELETE FROM public.users WHERE id = $1', [userId]);
      await client.query('RELEASE SAVEPOINT purge_user');
      usersDeleted += 1;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT purge_user');
      if ((error as { code?: string }).code !== '23503') throw error;
    }
  }

  await client.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
  await client.query(
    'UPDATE public.account_deletions SET purged_at = now() WHERE tenant_id = $1 AND scope = $2',
    [tenantId, 'business'],
  );

  for (const table of toggled)
    await client.query(`ALTER TABLE ${qualified(table)} ENABLE TRIGGER USER`);
  return { deleted, usersDeleted };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const mode: Mode = args.has('--execute')
    ? 'execute'
    : args.has('--rehearse')
      ? 'rehearse'
      : 'list';
  // --tenant <id> narrows to one business (rehearsing on a chosen one).
  const tenantArg = process.argv[process.argv.indexOf('--tenant') + 1];
  const onlyTenant = process.argv.includes('--tenant') ? tenantArg : undefined;

  const client = new pg.Client(migrationClientConfig());
  await client.connect();
  try {
    const due = onlyTenant
      ? (
          await client.query<DueDeletion>(
            `SELECT COALESCE(d.id, gen_random_uuid()) AS id, t.id AS "tenantId",
                    COALESCE(d.requested_at, now()) AS "requestedAt", COALESCE(d.purge_due_at, now()) AS "purgeDueAt"
             FROM public.tenants t
             LEFT JOIN public.account_deletions d ON d.tenant_id = t.id AND d.scope = 'business'
             WHERE t.id = $1`,
            [onlyTenant],
          )
        ).rows
      : (
          await client.query<DueDeletion>(
            `SELECT id, tenant_id AS "tenantId", requested_at AS "requestedAt", purge_due_at AS "purgeDueAt"
             FROM public.account_deletions
             WHERE scope = 'business' AND purged_at IS NULL
             ORDER BY requested_at`,
          )
        ).rows;

    if (onlyTenant && mode === 'execute') {
      const requested = await client.query(
        "SELECT 1 FROM public.account_deletions WHERE tenant_id = $1 AND scope = 'business'",
        [onlyTenant],
      );
      if (!requested.rowCount)
        throw new Error('Refusing to execute: that business never asked to be deleted.');
    }

    console.log(`${due.length} business deletion(s) to purge. Mode: ${mode}.`);
    const tables = await tenantTables(client);

    for (const d of due) {
      const counts = await countRows(client, tables, d.tenantId);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(
        `\n${d.tenantId}  requested ${d.requestedAt.toISOString()}  due ${d.purgeDueAt.toISOString()}  rows ${total}`,
      );
      for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
      if (mode === 'list') continue;

      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '15s'");
      try {
        const result = await purgeTenant(client, d.tenantId, tables);
        const left = await countRows(client, tables, d.tenantId);
        if (Object.keys(left).length > 0)
          throw new Error(`Rows left after purge: ${JSON.stringify(left)}`);
        if (mode === 'rehearse') {
          await client.query('ROLLBACK');
          console.log(
            `  REHEARSED: would delete ${result.deleted} rows and ${result.usersDeleted} users. Rolled back.`,
          );
          continue;
        }
        await client.query('COMMIT');
        console.log(`  PURGED: ${result.deleted} rows, ${result.usersDeleted} users.`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`  FAILED, nothing deleted: ${(error as Error).message}`);
        process.exitCode = 1;
        continue;
      }

      try {
        const files = await removeAllForTenant(d.tenantId);
        console.log(`  Files deleted: ${files}`);
      } catch (error) {
        console.error(
          `  Records purged, but stored files could not be deleted: ${(error as Error).message}`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
