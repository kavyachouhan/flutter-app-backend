import type { Tx } from '../../db/tx.js';
import type { Role } from './permissions.js';

export interface LoginMembership {
  tenantId: string;
  tenantName: string;
  role: Role;
  outletIds: string[] | null;
}

export interface RefreshTokenRecord {
  id: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export interface UserProfile {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  locale: string | null;
}

export const authRepository = {
  async ensureUser(tx: Tx, input: { id: string; phone: string; name: string | null }) {
    const row = await tx.one<{ userId: string; isActive: boolean }>(
      'SELECT user_id AS "userId", is_active AS "isActive" FROM app.ensure_user($1, $2, $3)',
      [input.id, input.phone, input.name],
    );
    if (!row) throw new Error('app.ensure_user returned no row');
    return row;
  },

  async recordLogin(tx: Tx, userId: string): Promise<void> {
    await tx.query('SELECT app.record_login($1)', [userId]);
  },

  findMemberships(tx: Tx, userId: string): Promise<LoginMembership[]> {
    return tx.many<LoginMembership>(
      `SELECT tenant_id AS "tenantId", tenant_name AS "tenantName", role, outlet_ids AS "outletIds"
       FROM app.find_memberships_for_login($1)`,
      [userId],
    );
  },

  findRefreshToken(tx: Tx, tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    return tx.one<RefreshTokenRecord>(
      `SELECT id, tenant_id AS "tenantId", user_id AS "userId", device_id AS "deviceId",
              expires_at AS "expiresAt", revoked_at AS "revokedAt", replaced_by AS "replacedBy"
       FROM app.find_refresh_token($1)`,
      [tokenHash],
    );
  },

  async insertRefreshToken(
    tx: Tx,
    input: { id: string; userId: string; deviceId: string; tokenHash: string; ttlDays: number },
  ): Promise<Date> {
    const row = await tx.one<{ expiresAt: Date }>(
      `INSERT INTO refresh_tokens (id, tenant_id, user_id, device_id, token_hash, expires_at)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, now() + make_interval(days => $5::int))
       RETURNING expires_at AS "expiresAt"`,
      [input.id, input.userId, input.deviceId, input.tokenHash, input.ttlDays],
    );
    if (!row) throw new Error('refresh token insert returned no row');
    return row.expiresAt;
  },

  /** False when the token was already rotated or revoked by a concurrent request. */
  async rotateRefreshToken(tx: Tx, oldId: string, newId: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = $2
       WHERE id = $1 AND revoked_at IS NULL`,
      [oldId, newId],
    );
    return result.rowCount === 1;
  },

  async revokeForDevice(tx: Tx, deviceId: string, reason: string): Promise<void> {
    await tx.query(
      'UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2 WHERE device_id = $1 AND revoked_at IS NULL',
      [deviceId, reason],
    );
  },

  async revokeForUser(tx: Tx, userId: string, reason: string): Promise<void> {
    await tx.query(
      'UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, reason],
    );
  },

  findUserProfile(tx: Tx, userId: string): Promise<UserProfile | undefined> {
    return tx.one<UserProfile>('SELECT id, phone, name, email, locale FROM users WHERE id = $1', [
      userId,
    ]);
  },
};
