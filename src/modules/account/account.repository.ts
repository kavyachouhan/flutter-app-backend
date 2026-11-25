import { randomInt } from 'node:crypto';
import type { Tx } from '../../db/tx.js';

/**
 * A number that cannot belong to anyone: country code 999 is not assigned by
 * the ITU. The column must stay a valid-looking number (its CHECK), and is
 * unique only among live users, so many erased users may share the prefix.
 */
export function erasedPhone(): string {
  let digits = '999';
  while (digits.length < 15) digits += String(randomInt(0, 10));
  return digits;
}

export const accountRepository = {
  /** Removes a person's identifying details. Their user id stays, so the business's records still say who made a bill. */
  async eraseUser(tx: Tx, userId: string): Promise<void> {
    const result = await tx.query(
      `UPDATE users
       SET phone = $2, phone_verified = false, name = NULL, email = NULL,
           is_active = false, deleted_at = COALESCE(deleted_at, now())
       WHERE id = $1`,
      [userId, erasedPhone()],
    );
    // Row-level security turns a blocked UPDATE into "0 rows", not an error.
    // Erasure must never be reported as done when it was not.
    if (result.rowCount !== 1) throw new Error(`Could not erase user ${userId}`);
  },

  /** Every sign-in of the current business, revoked. RLS scopes it to the business. */
  async revokeAllSessions(tx: Tx, reason: string): Promise<void> {
    await tx.query(
      'UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $1 WHERE revoked_at IS NULL',
      [reason],
    );
  },

  async deactivateAllDevices(tx: Tx): Promise<void> {
    await tx.query('UPDATE devices SET is_active = false WHERE is_active');
  },

  async deactivateDevicesOf(tx: Tx, userId: string): Promise<void> {
    await tx.query('UPDATE devices SET is_active = false WHERE user_id = $1 AND is_active', [
      userId,
    ]);
  },

  async removeAllMemberships(tx: Tx): Promise<void> {
    await tx.query(
      'UPDATE memberships SET deleted_at = now(), is_active = false WHERE deleted_at IS NULL',
    );
  },

  async removeMembershipOf(tx: Tx, userId: string): Promise<void> {
    await tx.query(
      'UPDATE memberships SET deleted_at = now(), is_active = false WHERE user_id = $1 AND deleted_at IS NULL',
      [userId],
    );
  },

  /** The users of the current business — read before memberships are removed. */
  async memberUserIds(tx: Tx): Promise<string[]> {
    const rows = await tx.many<{ userId: string }>(
      'SELECT DISTINCT user_id AS "userId" FROM memberships WHERE deleted_at IS NULL',
    );
    return rows.map((r) => r.userId);
  },

  /** Closes the business: sign-in stops finding it (app.find_memberships_for_login). */
  async closeTenant(tx: Tx, tenantId: string): Promise<void> {
    await tx.query(
      "UPDATE tenants SET status = 'cancelled', deleted_at = COALESCE(deleted_at, now()) WHERE id = $1",
      [tenantId],
    );
  },

  async recordDeletion(
    tx: Tx,
    entry: {
      id: string;
      tenantId: string;
      userId: string;
      scope: 'business' | 'login';
      /** Days from now the purge must have run by. 0 for a request that is complete when made. */
      purgeWithinDays: number;
      purged: boolean;
    },
  ): Promise<{ purgeDueAt: Date }> {
    // Dates from the database clock, so the CHECK (due >= requested) can never
    // trip on a difference between this server's clock and the database's.
    const row = await tx.one<{ purgeDueAt: Date }>(
      `INSERT INTO account_deletions (id, tenant_id, user_id, scope, purge_due_at, purged_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), CASE WHEN $6 THEN now() END)
       RETURNING purge_due_at AS "purgeDueAt"`,
      [entry.id, entry.tenantId, entry.userId, entry.scope, entry.purgeWithinDays, entry.purged],
    );
    if (!row) throw new Error('account_deletions insert returned no row');
    return row;
  },
};
