import type { Tx } from '../../db/tx.js';
import { buildSet } from '../../db/sql.js';
import type { Role } from '../auth/permissions.js';

export interface MemberRow {
  id: string;
  userId: string;
  name: string | null;
  phone: string;
  role: Role;
  outletIds: string[] | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MEMBER_COLUMNS = `
  m.id, m.user_id AS "userId", u.name, u.phone, m.role, m.outlet_ids AS "outletIds",
  m.is_active AS "isActive", m.created_at AS "createdAt", m.updated_at AS "updatedAt"`;

const FROM = 'FROM memberships m JOIN users u ON u.id = m.user_id';

const UPDATABLE = { role: 'role', outletIds: 'outlet_ids', isActive: 'is_active' } as const;

export const membersRepository = {
  list(tx: Tx): Promise<MemberRow[]> {
    return tx.many<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} ${FROM} WHERE m.deleted_at IS NULL ORDER BY u.name NULLS LAST, m.id`,
    );
  },

  findById(tx: Tx, id: string, forUpdate = false): Promise<MemberRow | undefined> {
    return tx.one<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} ${FROM} WHERE m.id = $1 AND m.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF m' : ''}`,
      [id],
    );
  },

  findByUser(tx: Tx, userId: string): Promise<MemberRow | undefined> {
    return tx.one<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} ${FROM} WHERE m.user_id = $1 AND m.deleted_at IS NULL`,
      [userId],
    );
  },

  async insert(
    tx: Tx,
    input: { id: string; userId: string; role: Role; outletIds: readonly string[] | null },
  ) {
    await tx.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role, outlet_ids, is_active)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4::uuid[], true)`,
      [input.id, input.userId, input.role, input.outletIds ? [...input.outletIds] : null],
    );
  },

  async update(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE memberships SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE memberships SET deleted_at = now(), is_active = false WHERE id = $1', [
      id,
    ]);
  },

  /** Row locks on the active owners, so two concurrent demotions cannot remove both. */
  async lockActiveOwnerIds(tx: Tx): Promise<string[]> {
    const rows = await tx.many<{ id: string }>(
      "SELECT id FROM memberships WHERE role = 'owner' AND is_active AND deleted_at IS NULL ORDER BY id FOR UPDATE",
    );
    return rows.map((row) => row.id);
  },

  async countExistingOutlets(tx: Tx, outletIds: readonly string[]): Promise<number> {
    const row = await tx.one<{ count: number }>(
      'SELECT count(*) AS count FROM outlets WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [[...outletIds]],
    );
    return row?.count ?? 0;
  },
};
