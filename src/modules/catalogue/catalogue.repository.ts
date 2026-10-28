import type { Tx } from '../../db/tx.js';
import type { SupplyCategory } from '../../domain/tax/types.js';
import { buildSet, likeContains } from '../../db/sql.js';
import type { Cursor } from '../../lib/pagination.js';

export interface CategoryRow {
  id: string;
  parentId: string | null;
  name: string;
  /** Name of an icon the app ships with; null = the default. */
  icon: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemRow {
  id: string;
  categoryId: string | null;
  itemType: 'goods' | 'service';
  name: string;
  code: string | null;
  aliases: string[];
  hsnCode: string | null;
  taxRatePercent: number;
  cessRatePercent: number;
  unit: string;
  mrp: number | null;
  salePrice: number;
  /** Object key of the item's photo in the storage bucket; null = no photo. */
  imageObjectKey: string | null;
  discountPercent: number | null;
  purchasePrice: number | null;
  pricesIncludeTax: boolean;
  trackStock: boolean;
  reorderLevel: number | null;
  supplyCategory: SupplyCategory;
  isActive: boolean;
  barcodes: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type NewItem = Omit<ItemRow, 'barcodes' | 'createdAt' | 'updatedAt'>;

const CATEGORY_COLUMNS =
  'id, parent_id AS "parentId", name, icon, created_at AS "createdAt", updated_at AS "updatedAt"';

const ITEM_COLUMNS = `
  i.id, i.category_id AS "categoryId", i.item_type AS "itemType", i.name, i.code, i.aliases,
  i.hsn_code AS "hsnCode", i.tax_rate_percent AS "taxRatePercent", i.cess_rate_percent AS "cessRatePercent",
  i.unit, i.mrp, i.sale_price AS "salePrice", i.discount_percent AS "discountPercent",
  i.image_object_key AS "imageObjectKey",
  i.purchase_price AS "purchasePrice",
  i.prices_include_tax AS "pricesIncludeTax", i.track_stock AS "trackStock", i.reorder_level AS "reorderLevel",
  i.supply_category AS "supplyCategory",
  i.is_active AS "isActive", i.created_at AS "createdAt", i.updated_at AS "updatedAt",
  COALESCE((SELECT array_agg(b.barcode ORDER BY b.barcode) FROM item_barcodes b
            WHERE b.item_id = i.id AND b.deleted_at IS NULL), '{}') AS barcodes`;

const CATEGORY_UPDATABLE = { name: 'name', parentId: 'parent_id', icon: 'icon' } as const;

const ITEM_UPDATABLE = {
  categoryId: 'category_id',
  itemType: 'item_type',
  name: 'name',
  code: 'code',
  aliases: 'aliases',
  hsnCode: 'hsn_code',
  taxRatePercent: 'tax_rate_percent',
  cessRatePercent: 'cess_rate_percent',
  unit: 'unit',
  mrp: 'mrp',
  salePrice: 'sale_price',
  discountPercent: 'discount_percent',
  imageObjectKey: 'image_object_key',
  purchasePrice: 'purchase_price',
  pricesIncludeTax: 'prices_include_tax',
  trackStock: 'track_stock',
  reorderLevel: 'reorder_level',
  supplyCategory: 'supply_category',
  isActive: 'is_active',
} as const;

export interface ItemFilter {
  q: string | undefined;
  categoryId: string | undefined;
  itemType: string | undefined;
  includeInactive: boolean;
}

export const catalogueRepository = {
  listCategories(tx: Tx): Promise<CategoryRow[]> {
    return tx.many<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE deleted_at IS NULL ORDER BY name, id`,
    );
  },

  findCategory(tx: Tx, id: string): Promise<CategoryRow | undefined> {
    return tx.one<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  },

  async insertCategory(
    tx: Tx,
    c: { id: string; name: string; parentId: string | null; icon: string | null },
  ): Promise<void> {
    await tx.query(
      'INSERT INTO categories (id, tenant_id, name, parent_id, icon) VALUES ($1, app.current_tenant_id(), $2, $3, $4)',
      [c.id, c.name, c.parentId, c.icon],
    );
  },

  async updateCategory(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, CATEGORY_UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE categories SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  /** True if `candidateParentId` is `id` or one of its descendants, which would create a cycle. */
  async wouldCreateCycle(tx: Tx, id: string, candidateParentId: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM categories WHERE id = $1
         UNION
         SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id WHERE c.deleted_at IS NULL
       )
       SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $2) AS found`,
      [id, candidateParentId],
    );
    return row?.found ?? false;
  },

  async categoryInUse(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ inUse: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM categories WHERE parent_id = $1 AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM items WHERE category_id = $1 AND deleted_at IS NULL) AS "inUse"`,
      [id],
    );
    return row?.inUse ?? false;
  },

  async softDeleteCategory(tx: Tx, id: string): Promise<void> {
    await tx.query('UPDATE categories SET deleted_at = now() WHERE id = $1', [id]);
  },

  listItems(
    tx: Tx,
    filter: ItemFilter,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<ItemRow[]> {
    return tx.many<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items i
       WHERE i.deleted_at IS NULL
         AND ($1::boolean OR i.is_active)
         AND ($2::uuid IS NULL OR i.category_id = $2)
         AND ($3::text IS NULL OR i.item_type = $3)
         AND ($4::text IS NULL
              OR i.name ILIKE $4 OR i.code ILIKE $4
              OR lower($5::text) = ANY(i.aliases)
              OR EXISTS (SELECT 1 FROM item_barcodes b
                         WHERE b.item_id = i.id AND b.barcode = $5 AND b.deleted_at IS NULL))
         AND ($6::text IS NULL OR (i.name, i.id) > ($6::text, $7::uuid))
       ORDER BY i.name, i.id
       LIMIT $8`,
      [
        filter.includeInactive,
        filter.categoryId ?? null,
        filter.itemType ?? null,
        filter.q ? likeContains(filter.q) : null,
        filter.q ?? null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  findItem(tx: Tx, id: string): Promise<ItemRow | undefined> {
    return tx.one<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items i WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [id],
    );
  },

  findItemByBarcode(tx: Tx, barcode: string): Promise<ItemRow | undefined> {
    return tx.one<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items i JOIN item_barcodes b ON b.item_id = i.id
       WHERE b.barcode = $1 AND b.deleted_at IS NULL AND i.deleted_at IS NULL`,
      [barcode],
    );
  },

  async insertItem(tx: Tx, item: NewItem): Promise<void> {
    await tx.query(
      `INSERT INTO items (id, tenant_id, category_id, item_type, name, code, aliases, hsn_code, tax_rate_percent,
         cess_rate_percent, unit, mrp, sale_price, discount_percent, purchase_price, prices_include_tax, track_stock,
         reorder_level, supply_category, is_active, image_object_key)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        item.id,
        item.categoryId,
        item.itemType,
        item.name,
        item.code,
        item.aliases,
        item.hsnCode,
        item.taxRatePercent,
        item.cessRatePercent,
        item.unit,
        item.mrp,
        item.salePrice,
        item.discountPercent,
        item.purchasePrice,
        item.pricesIncludeTax,
        item.trackStock,
        item.reorderLevel,
        item.supplyCategory,
        item.isActive,
        item.imageObjectKey,
      ],
    );
  },

  async updateItem(tx: Tx, id: string, patch: Record<string, unknown>): Promise<void> {
    const { clause, values } = buildSet(patch, ITEM_UPDATABLE, 2);
    if (clause) await tx.query(`UPDATE items SET ${clause} WHERE id = $1`, [id, ...values]);
  },

  /**
   * Soft delete, not DELETE: a removed row is invisible to a syncing device,
   * which would keep resolving the barcode at the till. The partial unique
   * index is what lets the same barcode be inserted again afterwards.
   */
  async replaceBarcodes(tx: Tx, itemId: string, barcodes: readonly string[]): Promise<void> {
    await tx.query(
      'UPDATE item_barcodes SET deleted_at = now() WHERE item_id = $1 AND deleted_at IS NULL',
      [itemId],
    );
    if (barcodes.length === 0) return;
    await tx.query(
      `INSERT INTO item_barcodes (id, tenant_id, item_id, barcode)
       SELECT gen_random_uuid(), app.current_tenant_id(), $1, code FROM unnest($2::text[]) AS code`,
      [itemId, [...new Set(barcodes)]],
    );
  },

  /** Barcodes are freed so a replacement item can reuse them. */
  async softDeleteItem(tx: Tx, id: string): Promise<void> {
    await tx.query(
      'UPDATE item_barcodes SET deleted_at = now() WHERE item_id = $1 AND deleted_at IS NULL',
      [id],
    );
    await tx.query('UPDATE items SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
  },
};
