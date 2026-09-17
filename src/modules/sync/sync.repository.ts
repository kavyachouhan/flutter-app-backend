import type { Tx } from '../../db/tx.js';
import { SYNC_TABLES, type SyncedTable } from './sync.registry.js';

export interface ChangeRow {
  entity: string;
  serverSeq: number;
  deleted: boolean;
  row: Record<string, unknown>;
}

export interface DeviceSyncState {
  deviceId: string;
  lastPullSeq: number;
  lastPullAt: Date | null;
  lastPushAt: Date | null;
  fullResyncRequired: boolean;
}

export interface SyncBatchInsert {
  id: string;
  deviceId: string;
  kind: 'push' | 'pull';
  startedAt: Date;
  durationMs: number;
  operations?: number;
  applied?: number;
  replayed?: number;
  rejected?: number;
  sinceSeq?: number;
  untilSeq?: number;
  changes?: number;
  requestId?: string | undefined;
}

/** Tables the push dispatcher may probe for existence or version. */
const PROBEABLE = new Set(SYNC_TABLES.map((t) => t.table));

function branch(t: SyncedTable): string {
  const tenantFilter = `t.${t.tenantColumn} = app.current_tenant_id()`;
  const deleted = t.softDelete ? 't.deleted_at IS NOT NULL' : 'false';
  const row = t.join
    ? `(to_jsonb(t) - 'tenant_id') || jsonb_build_object(${t.join.fields})`
    : `(to_jsonb(t) - 'tenant_id')`;
  return `SELECT '${t.entity}' AS entity, t.server_seq AS "serverSeq", ${deleted} AS deleted, ${row} AS row
          FROM ${t.table} t ${t.join?.sql ?? ''}
          WHERE ${tenantFilter} AND t.server_seq > $1`;
}

// Built once: a UNION ALL over every synced table, ordered by the tenant-wide
// sequence. Each branch hits its own (tenant_id, server_seq) index and the
// planner merges them; a single statement also means a single snapshot.
const CHANGES_SQL = `${SYNC_TABLES.map(branch).join('\n          UNION ALL\n')}
          ORDER BY "serverSeq" LIMIT $2`;

export const syncRepository = {
  listChanges(tx: Tx, since: number, limit: number): Promise<ChangeRow[]> {
    return tx.many<ChangeRow>(CHANGES_SQL, [since, limit]);
  },

  async getState(tx: Tx, deviceId: string): Promise<DeviceSyncState> {
    const row = await tx.one<DeviceSyncState>(
      `SELECT device_id AS "deviceId", last_pull_seq AS "lastPullSeq", last_pull_at AS "lastPullAt",
              last_push_at AS "lastPushAt", full_resync_required AS "fullResyncRequired"
       FROM device_sync_state WHERE device_id = $1`,
      [deviceId],
    );
    return (
      row ?? {
        deviceId,
        lastPullSeq: 0,
        lastPullAt: null,
        lastPushAt: null,
        fullResyncRequired: false,
      }
    );
  },

  /** Records what the device has applied; never moves the cursor backwards. */
  async beginPull(tx: Tx, deviceId: string, since: number): Promise<DeviceSyncState> {
    const row = await tx.one<DeviceSyncState>(
      `INSERT INTO device_sync_state AS s (tenant_id, device_id, last_pull_seq, last_pull_at)
       VALUES (app.current_tenant_id(), $1, $2, now())
       ON CONFLICT (tenant_id, device_id) DO UPDATE
         SET last_pull_seq = GREATEST(s.last_pull_seq, EXCLUDED.last_pull_seq), last_pull_at = now()
       RETURNING device_id AS "deviceId", last_pull_seq AS "lastPullSeq", last_pull_at AS "lastPullAt",
                 last_push_at AS "lastPushAt", full_resync_required AS "fullResyncRequired"`,
      [deviceId, since],
    );
    if (!row) throw new Error('device_sync_state upsert returned no row');
    return row;
  },

  async markPushed(tx: Tx, deviceId: string): Promise<void> {
    await tx.query(
      `INSERT INTO device_sync_state (tenant_id, device_id, last_push_at)
       VALUES (app.current_tenant_id(), $1, now())
       ON CONFLICT (tenant_id, device_id) DO UPDATE SET last_push_at = now()`,
      [deviceId],
    );
  },

  async clearResetFlag(tx: Tx, deviceId: string): Promise<void> {
    await tx.query(
      'UPDATE device_sync_state SET full_resync_required = false WHERE device_id = $1',
      [deviceId],
    );
  },

  async insertBatch(tx: Tx, b: SyncBatchInsert): Promise<void> {
    await tx.query(
      `INSERT INTO sync_batches (id, tenant_id, device_id, kind, started_at, duration_ms, operations, applied,
                                 replayed, rejected, since_seq, until_seq, changes, request_id)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        b.id,
        b.deviceId,
        b.kind,
        b.startedAt,
        b.durationMs,
        b.operations ?? 0,
        b.applied ?? 0,
        b.replayed ?? 0,
        b.rejected ?? 0,
        b.sinceSeq ?? null,
        b.untilSeq ?? null,
        b.changes ?? 0,
        b.requestId ?? null,
      ],
    );
  },

  /** The version of one row, for optimistic-concurrency checks on pushed updates. */
  async serverSeqOf(tx: Tx, table: string, id: string): Promise<number | undefined> {
    if (!PROBEABLE.has(table)) throw new Error(`Table ${table} is not synced.`);
    const row = await tx.one<{ serverSeq: number }>(
      `SELECT server_seq AS "serverSeq" FROM ${table} WHERE id = $1`,
      [id],
    );
    return row?.serverSeq;
  },
};
