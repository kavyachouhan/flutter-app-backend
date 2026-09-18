import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { booleanQuery, gstRate, hsnCode, nonEmpty, paise } from '../../lib/validators.js';

export const createCategoryBody = z.object({
  id: clientId,
  name: nonEmpty,
  parentId: z.string().uuid().nullable().optional(),
});
export type CreateCategoryBody = z.infer<typeof createCategoryBody>;

export const updateCategoryBody = createCategoryBody.omit({ id: true }).partial();
export type UpdateCategoryBody = z.infer<typeof updateCategoryBody>;

const itemFields = {
  categoryId: z.string().uuid().nullable().optional(),
  itemType: z.enum(['goods', 'service']),
  name: nonEmpty,
  code: nonEmpty.nullable().optional(),
  aliases: z.array(nonEmpty).optional(),
  hsnCode: hsnCode.nullable().optional(),
  taxRatePercent: gstRate,
  cessRatePercent: z.number().nonnegative().optional(),
  unit: nonEmpty,
  mrp: paise.nullable().optional(),
  salePrice: paise,
  purchasePrice: paise.nullable().optional(),
  pricesIncludeTax: z.boolean().optional(),
  trackStock: z.boolean().optional(),
  /** Thousandths of a unit. */
  reorderLevel: paise.nullable().optional(),
  isActive: z.boolean().optional(),
  barcodes: z.array(nonEmpty).optional(),
};

export const createItemBody = z.object({ id: clientId, ...itemFields });
export type CreateItemBody = z.infer<typeof createItemBody>;

export const updateItemBody = z.object(itemFields).partial();
export type UpdateItemBody = z.infer<typeof updateItemBody>;

export const listItemsQuery = pageQuery.extend({
  q: nonEmpty.optional(),
  categoryId: z.string().uuid().optional(),
  itemType: z.enum(['goods', 'service']).optional(),
  includeInactive: booleanQuery.optional(),
});
export type ListItemsQuery = z.infer<typeof listItemsQuery>;

export const barcodeParams = z.object({ barcode: nonEmpty });
