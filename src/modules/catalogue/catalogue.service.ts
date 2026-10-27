import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { diffFields, recordAudit } from '../audit/audit.js';
import { assertQuota } from '../entitlements/entitlements.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { catalogueRepository, type ItemRow } from './catalogue.repository.js';
import type {
  CreateCategoryBody,
  CreateItemBody,
  ListItemsQuery,
  UpdateCategoryBody,
  UpdateItemBody,
} from './catalogue.schemas.js';

// Changes that affect money on future bills are always audited.
const PRICE_FIELDS = [
  'salePrice',
  'mrp',
  'discountPercent',
  'purchasePrice',
  'taxRatePercent',
  'cessRatePercent',
  'pricesIncludeTax',
] as const;

/** Stored lower-case so alias search is case-insensitive without a functional index. */
function normaliseAliases(aliases: readonly string[] | undefined): string[] | undefined {
  return aliases === undefined ? undefined : [...new Set(aliases.map((a) => a.toLowerCase()))];
}

async function requireCategory(tx: Tx, id: string) {
  const category = await catalogueRepository.findCategory(tx, id);
  if (!category) throw new NotFoundError('Category');
  return category;
}

async function requireItem(tx: Tx, id: string): Promise<ItemRow> {
  const item = await catalogueRepository.findItem(tx, id);
  if (!item) throw new NotFoundError('Item');
  return item;
}

function assertStockTracking(itemType: string, trackStock: boolean): void {
  if (itemType === 'service' && trackStock) {
    throw new ValidationError('A service item cannot track stock.', {
      details: { fields: { trackStock: 'not allowed' } },
    });
  }
}

export function listCategories() {
  return withReadTransaction((tx) => catalogueRepository.listCategories(tx));
}

export function createCategory(body: CreateCategoryBody) {
  return withTransaction(async (tx) => {
    const existing = await catalogueRepository.findCategory(tx, body.id);
    if (existing) return existing;
    if (body.parentId) await requireCategory(tx, body.parentId);
    await catalogueRepository.insertCategory(tx, {
      id: body.id,
      name: body.name,
      parentId: body.parentId ?? null,
    });
    return requireCategory(tx, body.id);
  });
}

export function updateCategory(id: string, patch: UpdateCategoryBody) {
  return withTransaction(async (tx) => {
    await requireCategory(tx, id);
    if (patch.parentId) {
      await requireCategory(tx, patch.parentId);
      if (await catalogueRepository.wouldCreateCycle(tx, id, patch.parentId)) {
        throw new ValidationError('A category cannot be moved under itself.');
      }
    }
    await catalogueRepository.updateCategory(tx, id, patch);
    return requireCategory(tx, id);
  });
}

export function deleteCategory(id: string) {
  return withTransaction(async (tx) => {
    await requireCategory(tx, id);
    if (await catalogueRepository.categoryInUse(tx, id)) {
      throw new UnprocessableError(
        'Move or delete the items and sub-categories in this category first.',
      );
    }
    await catalogueRepository.softDeleteCategory(tx, id);
  });
}

export async function listItems(query: ListItemsQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    catalogueRepository.listItems(
      tx,
      {
        q: query.q,
        categoryId: query.categoryId,
        itemType: query.itemType,
        includeInactive: query.includeInactive ?? false,
      },
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.name, id: row.id }));
}

export async function getItem(id: string) {
  return withReadTransaction((tx) => requireItem(tx, id));
}

export async function getItemByBarcode(barcode: string) {
  const item = await withReadTransaction((tx) =>
    catalogueRepository.findItemByBarcode(tx, barcode),
  );
  if (!item) throw new NotFoundError('Item');
  return item;
}

export function createItem(body: CreateItemBody) {
  const trackStock = body.trackStock ?? body.itemType === 'goods';
  assertStockTracking(body.itemType, trackStock);

  return withTransaction(async (tx) => {
    const existing = await catalogueRepository.findItem(tx, body.id);
    if (existing) return existing;

    await assertQuota(tx, 'items');
    if (body.categoryId) await requireCategory(tx, body.categoryId);
    const settings = await tenantsRepository.getSettings(tx);

    await catalogueRepository.insertItem(tx, {
      id: body.id,
      categoryId: body.categoryId ?? null,
      itemType: body.itemType,
      name: body.name,
      code: body.code ?? null,
      aliases: normaliseAliases(body.aliases) ?? [],
      hsnCode: body.hsnCode ?? null,
      taxRatePercent: body.taxRatePercent,
      cessRatePercent: body.cessRatePercent ?? 0,
      unit: body.unit,
      mrp: body.mrp ?? null,
      salePrice: body.salePrice,
      discountPercent: body.discountPercent ?? null,
      purchasePrice: body.purchasePrice ?? null,
      pricesIncludeTax: body.pricesIncludeTax ?? settings.defaultPricesIncludeTax,
      trackStock,
      reorderLevel: body.reorderLevel ?? null,
      supplyCategory: body.supplyCategory ?? 'taxable',
      isActive: body.isActive ?? true,
    });
    if (body.barcodes) await catalogueRepository.replaceBarcodes(tx, body.id, body.barcodes);

    return requireItem(tx, body.id);
  });
}

export function updateItem(id: string, patch: UpdateItemBody) {
  return withTransaction(async (tx) => {
    const before = await requireItem(tx, id);
    assertStockTracking(patch.itemType ?? before.itemType, patch.trackStock ?? before.trackStock);
    if (patch.categoryId) await requireCategory(tx, patch.categoryId);

    const { barcodes, ...fields } = { ...patch, aliases: normaliseAliases(patch.aliases) };
    await catalogueRepository.updateItem(tx, id, fields);
    if (barcodes) await catalogueRepository.replaceBarcodes(tx, id, barcodes);

    const changes = diffFields(before, patch);
    if (changes && PRICE_FIELDS.some((field) => field in changes)) {
      await recordAudit(tx, {
        action: 'item.price_changed',
        entityType: 'item',
        entityId: id,
        changes,
      });
    }
    return requireItem(tx, id);
  });
}

export function deleteItem(id: string) {
  return withTransaction(async (tx) => {
    await requireItem(tx, id);
    await catalogueRepository.softDeleteItem(tx, id);
    await recordAudit(tx, { action: 'item.deleted', entityType: 'item', entityId: id });
  });
}
