import { buildSet } from '../../db/sql.js';
import type { Tx } from '../../db/tx.js';
import type { PriceListBasis } from '../../domain/pricing/resolve.js';
import type { Cursor } from '../../lib/pagination.js';

export interface PriceListRow {
  id: string;
  name: string;
  kind: 'retail' | 'wholesale' | 'distributor' | 'custom';
  basis: PriceListBasis;
  /** pg returns NUMERIC as a string; the service casts before arithmetic. */
  basisValue: string;
  minPriceFloor: number | null;
  isDefault: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceListItemRow {
  priceListId: string;
  itemId: string;
  itemName: string;
  minQuantity: number;
  unitPrice: number;
  pricesIncludeTax: boolean;
}

export interface NewPriceList {
  id: string;
  name: string;
  kind: string;
  basis: string;
  basisValue: number;
  minPriceFloor: number | null;
  isDefault: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface PriceListItemUpsert {
  itemId: string;
  minQuantity: number;
  unitPrice: number;
  pricesIncludeTax: boolean;
}

const LIST_COLUMNS = `
  id, name, kind, basis, basis_value AS "basisValue", min_price_floor AS "minPriceFloor",
  is_default AS "isDefault", effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
  is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"`;

const LIST_UPDATABLE = {
  name: 'name',
  kind: 'kind',
  basis: 'basis',
  basisValue: 'basis_value',
  minPriceFloor: 'min_price_floor',
  isDefault: 'is_default',
  effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to',
  isActive: 'is_active',
} as const;

export const priceListsRepository = {
  find(tx: Tx, id: string): Promise<PriceListRow | undefined> {
    return tx.one<PriceListRow>(
      `SELECT ${LIST_COLUMNS} FROM price_lists WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  },

  /**
   * The list a customer with none assigned is priced on. Also the list the
   * `/resolve` endpoint falls back to, so a walk-in and an unassigned
   * customer are priced the same way.
   */
  findDefault(tx: Tx, on: string): Promise<PriceListRow | undefined> {
    return tx.one<PriceListRow>(
      `SELECT ${LIST_COLUMNS} FROM price_lists
       WHERE is_default AND is_active AND deleted_at IS NULL
         AND (effective_from IS NULL OR effective_from <= $1::date)
         AND (effective_to IS NULL OR effective_to >= $1::date)`,
      [on],
    );
  },

  /**
   * The list by id, but only if it is live on the given date. A list whose
   * window has closed must not price a sale, and silently falling back to the
   * item price is better than charging last season's wholesale rate.
   */
  findEffective(tx: Tx, id: string, on: string): Promise<PriceListRow | undefined> {
    return tx.one<PriceListRow>(
      `SELECT ${LIST_COLUMNS} FROM price_lists
       WHERE id = $1 AND is_active AND deleted_at IS NULL
         AND (effective_from IS NULL OR effective_from <= $2::date)
         AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [id, on],
    );
  },

  list(
    tx: Tx,
    filter: { kind: string | undefined; includeInactive: boolean },
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<PriceListRow[]> {
    return tx.many<PriceListRow>(
      `SELECT ${LIST_COLUMNS} FROM price_lists
       WHERE deleted_at IS NULL
         AND ($1::text IS NULL OR kind = $1)
         AND ($2::boolean OR is_active)
         AND ($3::text IS NULL OR (name, id) > ($3::text, $4::uuid))
       ORDER BY name, id
       LIMIT $5`,
      [
        filter.kind ?? null,
        filter.includeInactive,
        cursor?.k ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async insert(tx: Tx, list: NewPriceList): Promise<void> {
    await tx.query(
      `INSERT INTO price_lists (id, tenant_id, name, kind, basis, basis_value, min_price_floor,
         is_default, effective_from, effective_to, is_active)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        list.id,
        list.name,
        list.kind,
        list.basis,
        list.basisValue,
        list.minPriceFloor,
        list.isDefault,
        list.effectiveFrom,
        list.effectiveTo,
        list.isActive,
      ],
    );
  },

  async update(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, LIST_UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE price_lists SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  /**
   * Clears the default flag from every other list.
   *
   * The partial unique index would reject a second default anyway, but it
   * would reject it as a DUPLICATE the caller has to interpret. Promoting one
   * list demotes the rest, which is what "make this the default" means.
   */
  async clearDefaultExcept(tx: Tx, id: string): Promise<void> {
    await tx.query(
      'UPDATE price_lists SET is_default = false WHERE id <> $1 AND is_default AND deleted_at IS NULL',
      [id],
    );
  },

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE price_lists SET deleted_at = now(), is_default = false WHERE id = $1', [
      id,
    ]);
  },

  /** How many customers are priced on this list, so a delete can refuse. */
  async countCustomers(tx: Tx, id: string): Promise<number> {
    const row = await tx.one<{ count: string }>(
      'SELECT count(*) AS count FROM customers WHERE price_list_id = $1 AND deleted_at IS NULL',
      [id],
    );
    return Number(row?.count ?? 0);
  },

  /**
   * Every price the list holds for one item, which is the quantity-break
   * ladder the pure resolver picks from.
   */
  entriesFor(tx: Tx, priceListId: string, itemId: string): Promise<PriceListItemRow[]> {
    return tx.many<PriceListItemRow>(
      `SELECT pli.price_list_id AS "priceListId", pli.item_id AS "itemId", i.name AS "itemName",
              pli.min_quantity AS "minQuantity", pli.unit_price AS "unitPrice",
              pli.prices_include_tax AS "pricesIncludeTax"
       FROM price_list_items pli JOIN items i ON i.id = pli.item_id
       WHERE pli.price_list_id = $1 AND pli.item_id = $2 AND pli.deleted_at IS NULL
       ORDER BY pli.min_quantity`,
      [priceListId, itemId],
    );
  },

  /**
   * Every price the list holds for a set of items, for the billing path.
   *
   * One query rather than one per line: an invoice with thirty lines should
   * not make thirty round-trips inside the transaction that is holding the
   * number block.
   */
  entriesForItems(
    tx: Tx,
    priceListId: string,
    itemIds: readonly string[],
  ): Promise<{ itemId: string; minQuantity: number; unitPrice: number; pricesIncludeTax: boolean }[]> {
    if (itemIds.length === 0) return Promise.resolve([]);
    return tx.many(
      `SELECT item_id AS "itemId", min_quantity AS "minQuantity", unit_price AS "unitPrice",
              prices_include_tax AS "pricesIncludeTax"
       FROM price_list_items
       WHERE price_list_id = $1 AND item_id = ANY($2::uuid[]) AND deleted_at IS NULL
       ORDER BY item_id, min_quantity`,
      [priceListId, [...itemIds]],
    );
  },

  listItems(
    tx: Tx,
    priceListId: string,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<PriceListItemRow[]> {
    return tx.many<PriceListItemRow>(
      `SELECT pli.price_list_id AS "priceListId", pli.item_id AS "itemId", i.name AS "itemName",
              pli.min_quantity AS "minQuantity", pli.unit_price AS "unitPrice",
              pli.prices_include_tax AS "pricesIncludeTax"
       FROM price_list_items pli JOIN items i ON i.id = pli.item_id
       WHERE pli.price_list_id = $1 AND pli.deleted_at IS NULL
         AND ($2::text IS NULL OR (i.name, pli.item_id) > ($2::text, $3::uuid))
       ORDER BY i.name, pli.item_id, pli.min_quantity
       LIMIT $4`,
      [priceListId, cursor?.k ?? null, cursor?.id ?? null, limit + 1],
    );
  },

  /**
   * Upserts a batch of prices in one statement.
   *
   * `jsonb_to_recordset` rather than a statement per row: a thousand
   * round-trips inside one transaction is the slow path that makes a bulk
   * editor feel broken.
   */
  async upsertItems(
    tx: Tx,
    priceListId: string,
    items: readonly PriceListItemUpsert[],
  ): Promise<void> {
    if (items.length === 0) return;
    await tx.query(
      `INSERT INTO price_list_items (tenant_id, price_list_id, item_id, min_quantity, unit_price,
         prices_include_tax)
       SELECT app.current_tenant_id(), $1, r."itemId", r."minQuantity", r."unitPrice",
              r."pricesIncludeTax"
       FROM jsonb_to_recordset($2::jsonb) AS r(
         "itemId" uuid, "minQuantity" bigint, "unitPrice" bigint, "pricesIncludeTax" boolean)
       ON CONFLICT (tenant_id, price_list_id, item_id, min_quantity)
       DO UPDATE SET unit_price = EXCLUDED.unit_price,
                     prices_include_tax = EXCLUDED.prices_include_tax,
                     -- Revives a row the shop had removed. Without this,
                     -- re-adding a deleted price would silently do nothing.
                     deleted_at = NULL,
                     updated_at = now()`,
      [priceListId, JSON.stringify(items)],
    );
  },

  /**
   * Soft, not hard. The sync change feed reads the table itself, so a row that
   * no longer exists cannot be reported as deleted — a device would go on
   * pricing at a figure the shop removed.
   */
  async deleteAllItems(tx: Tx, priceListId: string): Promise<void> {
    await tx.query(
      `UPDATE price_list_items SET deleted_at = now(), updated_at = now()
       WHERE price_list_id = $1 AND deleted_at IS NULL`,
      [priceListId],
    );
  },

  async deleteItem(tx: Tx, priceListId: string, itemId: string): Promise<void> {
    await tx.query(
      `UPDATE price_list_items SET deleted_at = now(), updated_at = now()
       WHERE price_list_id = $1 AND item_id = $2 AND deleted_at IS NULL`,
      [priceListId, itemId],
    );
  },

  /** The same figures for a set of items, for the billing path. */
  async findPricedItems(
    tx: Tx,
    itemIds: readonly string[],
    outletId: string | null,
  ): Promise<
    Map<string, { salePrice: number; pricesIncludeTax: boolean; averageCost: number | null }>
  > {
    if (itemIds.length === 0) return new Map();
    const rows = await tx.many<{
      id: string;
      salePrice: number;
      pricesIncludeTax: boolean;
      averageCost: number | null;
    }>(
      `SELECT i.id, i.sale_price AS "salePrice", i.prices_include_tax AS "pricesIncludeTax",
              ic.avg_cost AS "averageCost"
       FROM items i
       LEFT JOIN item_costs ic ON ic.item_id = i.id
         AND ($2::uuid IS NULL OR ic.outlet_id = $2::uuid)
       WHERE i.id = ANY($1::uuid[])`,
      [[...itemIds], outletId],
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          salePrice: row.salePrice,
          pricesIncludeTax: row.pricesIncludeTax,
          averageCost: row.averageCost,
        },
      ]),
    );
  },

  /** The item figures the pure resolver needs, plus this outlet's average cost. */
  findPricedItem(
    tx: Tx,
    itemId: string,
    outletId: string | null,
  ): Promise<
    { salePrice: number; pricesIncludeTax: boolean; averageCost: number | null } | undefined
  > {
    return tx.one(
      `SELECT i.sale_price AS "salePrice", i.prices_include_tax AS "pricesIncludeTax",
              ic.avg_cost AS "averageCost"
       FROM items i
       LEFT JOIN item_costs ic
         ON ic.item_id = i.id AND ($2::uuid IS NULL OR ic.outlet_id = $2::uuid)
       WHERE i.id = $1 AND i.deleted_at IS NULL
       LIMIT 1`,
      [itemId, outletId],
    );
  },
};
