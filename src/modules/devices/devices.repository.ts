import type { Tx } from '../../db/tx.js';
import { buildSet } from '../../db/sql.js';
import type { DeviceInput } from '../auth/auth.schemas.js';

export interface DeviceRow {
  id: string;
  userId: string | null;
  userName: string | null;
  outletId: string | null;
  counterId: string | null;
  deviceKey: string;
  label: string | null;
  platform: string;
  appVersion: string | null;
  osVersion: string | null;
  /** From device_sync_state; null until the device has pulled once. */
  lastPullSeq: number | null;
  lastPullAt: Date | null;
  lastPushAt: Date | null;
  lastSeenAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DEVICE_COLUMNS = `
  d.id, d.user_id AS "userId", u.name AS "userName", d.outlet_id AS "outletId", d.counter_id AS "counterId",
  d.device_key AS "deviceKey", d.label, d.platform, d.app_version AS "appVersion", d.os_version AS "osVersion",
  s.last_pull_seq AS "lastPullSeq", s.last_pull_at AS "lastPullAt", s.last_push_at AS "lastPushAt",
  d.last_seen_at AS "lastSeenAt", d.is_active AS "isActive",
  d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

const FROM = `FROM devices d
  LEFT JOIN users u ON u.id = d.user_id
  LEFT JOIN device_sync_state s ON s.device_id = d.id AND s.tenant_id = d.tenant_id`;

const UPDATABLE = { label: 'label', outletId: 'outlet_id', counterId: 'counter_id' } as const;

export const devicesRepository = {
  /** A deactivated device stays deactivated when someone signs in on it again. */
  async upsertForSession(tx: Tx, input: { id: string; userId: string; device: DeviceInput }) {
    const row = await tx.one<{ id: string; isActive: boolean }>(
      `INSERT INTO devices (id, tenant_id, user_id, device_key, label, platform, app_version, os_version, last_seen_at, is_active)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, now(), true)
       ON CONFLICT (tenant_id, device_key) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         label = COALESCE(EXCLUDED.label, devices.label),
         platform = EXCLUDED.platform,
         app_version = EXCLUDED.app_version,
         os_version = EXCLUDED.os_version,
         last_seen_at = now()
       RETURNING id, is_active AS "isActive"`,
      [
        input.id,
        input.userId,
        input.device.deviceKey,
        input.device.label ?? null,
        input.device.platform,
        input.device.appVersion ?? null,
        input.device.osVersion ?? null,
      ],
    );
    if (!row) throw new Error('device upsert returned no row');
    return row;
  },

  list(tx: Tx): Promise<DeviceRow[]> {
    return tx.many<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} ${FROM} WHERE d.deleted_at IS NULL ORDER BY d.last_seen_at DESC NULLS LAST, d.id`,
    );
  },

  findById(tx: Tx, id: string): Promise<DeviceRow | undefined> {
    return tx.one<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} ${FROM} WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [id],
    );
  },

  async update(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE devices SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  async deactivate(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE devices SET is_active = false WHERE id = $1', [id]);
  },
};
