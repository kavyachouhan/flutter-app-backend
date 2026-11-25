/**
 * Purges businesses whose owners deleted them in the app.
 *
 * The privileged part — deleting rows of tables whose triggers forbid it —
 * is `app.purge_deleted_business` (migration 0051), which the API's own
 * database role may call. So this runs inside the API, on a schedule
 * (purge-scheduler.ts), and from `npm run purge:accounts`, without anyone
 * holding the owner's credentials.
 *
 * Per business, in this order:
 *   1. its stored files are deleted (storage is not transactional);
 *   2. its rows are deleted in one transaction, all or nothing.
 * If step 1 fails, step 2 is not attempted and the next run tries both
 * again. If step 2 fails, the files are already gone — the business was
 * closed when its owner deleted it, so nothing can miss them — and the next
 * run purges the rows.
 *
 * Only businesses listed by `app.due_business_deletions` are touched: ones
 * whose owner asked for deletion and that are already closed.
 */
import { pool } from '../../db/pool.js';
import { removeAllForTenant } from '../../lib/storage.js';

export interface DueDeletion {
  tenantId: string;
  requestedAt: Date;
  purgeDueAt: Date;
}

export type PurgeStatus = 'purged' | 'rehearsed' | 'already_purged' | 'failed';

export interface PurgeOutcome {
  tenantId: string;
  status: PurgeStatus;
  rowsDeleted?: number;
  usersDeleted?: number;
  filesDeleted?: number;
  error?: string;
}

export interface PurgeOptions {
  /** Only deletions whose promised date is on or before this; all when absent. */
  dueBy?: Date;
  /** Narrow to one business. */
  onlyTenant?: string;
  /** Delete the rows, then roll back. Files are left alone. */
  rehearse?: boolean;
  /** Replaced in tests. */
  deleteFiles?: (tenantId: string) => Promise<number>;
}

/** How long one business's delete may take before it is abandoned and retried. */
const STATEMENT_TIMEOUT = '10min';
/**
 * How long to wait for a table lock. The purge switches triggers off, which
 * blocks writes to those tables; a busy table gives up the purge, not the
 * shop's billing. The next run tries again.
 */
const LOCK_TIMEOUT = '15s';

export async function listDueDeletions(options: PurgeOptions = {}): Promise<DueDeletion[]> {
  const r = await pool.query<DueDeletion>(
    `SELECT tenant_id AS "tenantId", requested_at AS "requestedAt", purge_due_at AS "purgeDueAt"
     FROM app.due_business_deletions($1)`,
    [options.dueBy ?? null],
  );
  return options.onlyTenant ? r.rows.filter((d) => d.tenantId === options.onlyTenant) : r.rows;
}

/** Purges one business that {@link listDueDeletions} listed. */
export async function purgeBusiness(
  tenantId: string,
  options: Pick<PurgeOptions, 'rehearse' | 'deleteFiles'> = {},
): Promise<PurgeOutcome> {
  let filesDeleted: number | undefined;
  if (!options.rehearse) {
    try {
      filesDeleted = await (options.deleteFiles ?? removeAllForTenant)(tenantId);
    } catch (error) {
      return { tenantId, status: 'failed', error: `stored files: ${message(error)}` };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const r = await client.query<{ rows_deleted: string; users_deleted: number }>(
      'SELECT rows_deleted, users_deleted FROM app.purge_deleted_business($1)',
      [tenantId],
    );
    await client.query(options.rehearse ? 'ROLLBACK' : 'COMMIT');
    const row = r.rows[0];
    if (!row) return { tenantId, status: 'already_purged', filesDeleted };
    return {
      tenantId,
      status: options.rehearse ? 'rehearsed' : 'purged',
      rowsDeleted: Number(row.rows_deleted),
      usersDeleted: row.users_deleted,
      filesDeleted,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { tenantId, status: 'failed', filesDeleted, error: message(error) };
  } finally {
    client.release();
  }
}

/** Purges every due business, one after another. One failing does not stop the rest. */
export async function purgeDueDeletions(options: PurgeOptions = {}): Promise<PurgeOutcome[]> {
  const due = await listDueDeletions(options);
  const outcomes: PurgeOutcome[] = [];
  for (const d of due) outcomes.push(await purgeBusiness(d.tenantId, options));
  return outcomes;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
