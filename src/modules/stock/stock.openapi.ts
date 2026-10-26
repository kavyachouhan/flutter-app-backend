import { z } from 'zod';
import { errorResponses, stockReasonCodeSchema } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  pageEnvelope,
  quantity,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { createAdjustmentBody, ledgerQuery, listBalancesQuery } from './stock.schemas.js';

export const stockBalanceSchema = registry.register(
  'StockBalance',
  z.object({
    itemId: uuid,
    itemName: z.string(),
    unit: z.string(),
    quantity: quantity.openapi({ description: 'On the shelf, from the stock ledger.' }),
    reserved: quantity.openapi({
      description: 'Promised to open sales orders. Stays on the shelf until invoiced.',
    }),
    available: z.number().int().openapi({
      description: 'What a new sale may take: quantity less reserved. Negative means oversold.',
    }),
    reorderLevel: quantity.nullable(),
    updatedAt: timestamp,
  }),
);

export const stockEntrySchema = registry.register(
  'StockEntry',
  z.object({
    id: uuid,
    outletId: uuid,
    itemId: uuid,
    entryType: z.enum(['opening', 'sale', 'sale_void', 'adjustment']),
    quantityDelta: quantity,
    reasonCode: stockReasonCodeSchema.nullable(),
    referenceType: z.string().nullable(),
    referenceId: uuid.nullable(),
    occurredAt: timestamp,
    note: z.string().nullable(),
    createdBy: uuid.nullable(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/stock/balances',
  tags: ['Stock'],
  summary: 'Current stock per item at an outlet',
  security: accessTokenSecurity,
  request: { query: listBalancesQuery },
  responses: {
    200: jsonResponse('Balances.', pageEnvelope(stockBalanceSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/stock/ledger',
  tags: ['Stock'],
  summary: 'Movement history for one item',
  security: accessTokenSecurity,
  request: { query: ledgerQuery },
  responses: {
    200: jsonResponse('Entries, newest first.', pageEnvelope(stockEntrySchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/stock/adjustments',
  tags: ['Stock'],
  summary: 'Manual adjustment with a reason code',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createAdjustmentBody } } } },
  responses: {
    201: jsonResponse('Recorded.', dataEnvelope(stockEntrySchema)),
    ...errorResponses(422),
  },
});
