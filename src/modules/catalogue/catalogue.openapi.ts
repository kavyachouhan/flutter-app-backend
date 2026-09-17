import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  noContent,
  pageEnvelope,
  paise,
  percent,
  quantity,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  barcodeParams,
  createCategoryBody,
  createItemBody,
  listItemsQuery,
  updateCategoryBody,
  updateItemBody,
} from './catalogue.schemas.js';

export const categorySchema = registry.register(
  'Category',
  z.object({
    id: uuid,
    parentId: uuid.nullable(),
    name: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

export const itemSchema = registry.register(
  'Item',
  z.object({
    id: uuid,
    categoryId: uuid.nullable(),
    itemType: z.enum(['goods', 'service']),
    name: z.string(),
    code: z.string().nullable(),
    aliases: z.array(z.string()),
    hsnCode: z.string().nullable(),
    taxRatePercent: percent,
    cessRatePercent: percent,
    unit: z.string(),
    mrp: paise.nullable(),
    salePrice: paise,
    purchasePrice: paise.nullable(),
    pricesIncludeTax: z.boolean(),
    trackStock: z.boolean(),
    reorderLevel: quantity.nullable(),
    isActive: z.boolean(),
    barcodes: z.array(z.string()),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

const body = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });

registry.registerPath({
  method: 'get',
  path: '/v1/categories',
  tags: ['Catalogue'],
  summary: 'List categories',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Categories.', dataEnvelope(z.array(categorySchema))),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/categories',
  tags: ['Catalogue'],
  summary: 'Create a category',
  security: accessTokenSecurity,
  request: { body: body(createCategoryBody) },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(categorySchema)),
    ...errorResponses(409),
  },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/categories/{id}',
  tags: ['Catalogue'],
  summary: 'Rename or re-parent a category',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(updateCategoryBody) },
  responses: {
    200: jsonResponse('Updated.', dataEnvelope(categorySchema)),
    ...errorResponses(409),
  },
});
registry.registerPath({
  method: 'delete',
  path: '/v1/categories/{id}',
  tags: ['Catalogue'],
  summary: 'Delete a category',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 204: noContent('Deleted.'), ...errorResponses(409) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/items',
  tags: ['Catalogue'],
  summary: 'Search items',
  description: '`q` matches name, code and aliases with fuzzy (trigram) matching.',
  security: accessTokenSecurity,
  request: { query: listItemsQuery },
  responses: { 200: jsonResponse('Items.', pageEnvelope(itemSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'get',
  path: '/v1/items/by-barcode/{barcode}',
  tags: ['Catalogue'],
  summary: 'Resolve a barcode to an item',
  security: accessTokenSecurity,
  request: { params: barcodeParams },
  responses: { 200: jsonResponse('Item.', dataEnvelope(itemSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'get',
  path: '/v1/items/{id}',
  tags: ['Catalogue'],
  summary: 'Get an item',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 200: jsonResponse('Item.', dataEnvelope(itemSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'post',
  path: '/v1/items',
  tags: ['Catalogue'],
  summary: 'Create an item',
  description:
    'Counts against the plan’s item quota. Replays with the same id return the existing item.',
  security: accessTokenSecurity,
  request: { body: body(createItemBody) },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(itemSchema)),
    ...errorResponses(402, 409),
  },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/items/{id}',
  tags: ['Catalogue'],
  summary: 'Update an item',
  description: 'Passing `barcodes` replaces the full set.',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(updateItemBody) },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(itemSchema)), ...errorResponses(409) },
});
registry.registerPath({
  method: 'delete',
  path: '/v1/items/{id}',
  tags: ['Catalogue'],
  summary: 'Delete an item (soft)',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 204: noContent('Deleted.'), ...errorResponses() },
});
