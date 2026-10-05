import type { Tx } from '../../db/tx.js';
import { buildSet } from '../../db/sql.js';

export interface OutletRow {
  id: string;
  name: string;
  code: string;
  gstin: string | null;
  stateCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  isActive: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CounterRow {
  id: string;
  outletId: string;
  name: string;
  code: string;
  isActive: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewOutlet = Omit<OutletRow, 'createdAt' | 'updatedAt'>;
export type NewCounter = Omit<CounterRow, 'createdAt' | 'updatedAt'>;

const OUTLET_COLUMNS = `
  id, name, code, gstin, state_code AS "stateCode", address_line1 AS "addressLine1",
  address_line2 AS "addressLine2", city, pincode, phone, is_active AS "isActive",
  is_default AS "isDefault", created_at AS "createdAt", updated_at AS "updatedAt"`;

const COUNTER_COLUMNS = `
  id, outlet_id AS "outletId", name, code, is_active AS "isActive", is_default AS "isDefault",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const OUTLET_UPDATABLE = {
  name: 'name',
  code: 'code',
  gstin: 'gstin',
  stateCode: 'state_code',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  pincode: 'pincode',
  phone: 'phone',
  isActive: 'is_active',
  isDefault: 'is_default',
} as const;

const COUNTER_UPDATABLE = {
  name: 'name',
  code: 'code',
  isActive: 'is_active',
  isDefault: 'is_default',
} as const;

const lock = (forUpdate: boolean) => (forUpdate ? 'FOR UPDATE' : '');

export const outletsRepository = {
  listOutlets(tx: Tx, restrictTo: readonly string[] | null): Promise<OutletRow[]> {
    return tx.many<OutletRow>(
      `SELECT ${OUTLET_COLUMNS} FROM outlets
       WHERE deleted_at IS NULL AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
       ORDER BY name, id`,
      [restrictTo ? [...restrictTo] : null],
    );
  },

  /**
   * The outlet a device belongs to when it has not been bound to one.
   *
   * A newly onboarded device has no outlet binding — onboarding creates the
   * device and the outlet in the same transaction and does not link them — so
   * anything that needs "where is this till" has to fall back to the default
   * outlet, which is the only one a single-branch shop has.
   */
  findDefaultOutlet(tx: Tx): Promise<OutletRow | undefined> {
    return tx.one<OutletRow>(
      `SELECT ${OUTLET_COLUMNS} FROM outlets
       WHERE deleted_at IS NULL AND is_active
       ORDER BY is_default DESC, created_at
       LIMIT 1`,
    );
  },

  findOutlet(tx: Tx, id: string, forUpdate = false): Promise<OutletRow | undefined> {
    return tx.one<OutletRow>(
      `SELECT ${OUTLET_COLUMNS} FROM outlets WHERE id = $1 AND deleted_at IS NULL ${lock(forUpdate)}`,
      [id],
    );
  },

  async insertOutlet(tx: Tx, o: NewOutlet): Promise<void> {
    await tx.query(
      `INSERT INTO outlets (id, tenant_id, name, code, gstin, state_code, address_line1, address_line2, city,
         pincode, phone, is_active, is_default)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        o.id,
        o.name,
        o.code,
        o.gstin,
        o.stateCode,
        o.addressLine1,
        o.addressLine2,
        o.city,
        o.pincode,
        o.phone,
        o.isActive,
        o.isDefault,
      ],
    );
  },

  async updateOutlet(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, OUTLET_UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE outlets SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  // The partial unique index allows one default, so the old one is cleared first.
  async clearDefaultOutlet(tx: Tx): Promise<void> {
    await tx.query('UPDATE outlets SET is_default = false WHERE is_default AND deleted_at IS NULL');
  },

  async softDeleteOutlet(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE outlets SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
  },

  async countLiveCounters(tx: Tx, outletId: string): Promise<number> {
    const row = await tx.one<{ count: number }>(
      'SELECT count(*) AS count FROM counters WHERE outlet_id = $1 AND deleted_at IS NULL',
      [outletId],
    );
    return row?.count ?? 0;
  },

  listCounters(
    tx: Tx,
    outletId: string | undefined,
    restrictTo: readonly string[] | null,
  ): Promise<CounterRow[]> {
    return tx.many<CounterRow>(
      `SELECT ${COUNTER_COLUMNS} FROM counters
       WHERE deleted_at IS NULL
         AND ($1::uuid IS NULL OR outlet_id = $1)
         AND ($2::uuid[] IS NULL OR outlet_id = ANY($2::uuid[]))
       ORDER BY outlet_id, name, id`,
      [outletId ?? null, restrictTo ? [...restrictTo] : null],
    );
  },

  findCounter(tx: Tx, id: string, forUpdate = false): Promise<CounterRow | undefined> {
    return tx.one<CounterRow>(
      `SELECT ${COUNTER_COLUMNS} FROM counters WHERE id = $1 AND deleted_at IS NULL ${lock(forUpdate)}`,
      [id],
    );
  },

  async insertCounter(tx: Tx, c: NewCounter): Promise<void> {
    await tx.query(
      `INSERT INTO counters (id, tenant_id, outlet_id, name, code, is_active, is_default)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6)`,
      [c.id, c.outletId, c.name, c.code, c.isActive, c.isDefault],
    );
  },

  async updateCounter(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, COUNTER_UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE counters SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  async clearDefaultCounter(tx: Tx, outletId: string): Promise<void> {
    await tx.query(
      'UPDATE counters SET is_default = false WHERE outlet_id = $1 AND is_default AND deleted_at IS NULL',
      [outletId],
    );
  },

  async softDeleteCounter(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE counters SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
  },
};
