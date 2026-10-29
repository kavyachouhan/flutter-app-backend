import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  pageEnvelope,
  paise,
  quantity,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { termsSnapshot } from '../terms/terms.openapi.js';
import {
  cancelEstimateBody,
  convertEstimateBody,
  createEstimateBody,
  ESTIMATE_STATUSES,
  listEstimatesQuery,
  summaryEstimatesQuery,
  updateEstimateBody,
} from './estimates.schemas.js';

const line = z.object({
  id: uuid,
  lineNo: z.number().int(),
  itemId: uuid.nullable().openapi({ description: 'Null for a custom (non-catalogue) line.' }),
  itemName: z.string(),
  hsnCode: z.string().nullable(),
  unit: z.string().nullable(),
  quantity,
  unitPrice: paise,
  taxableAmount: paise,
  lineTotal: paise,
});

const estimate = registry.register(
  'Estimate',
  z.object({
    id: uuid,
    outletId: uuid,
    documentNumber: z.string(),
    documentDate: calendarDate,
    validUntil: calendarDate.nullable(),
    customerId: uuid.nullable(),
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    placeOfSupplyStateCode: z.string().nullable(),
    isReverseCharge: z.boolean(),
    taxableAmount: paise,
    totalTax: paise,
    billDiscount: z.object({ kind: z.enum(['amount', 'percent']), value: z.number() }).nullable(),
    billDiscountAmount: paise,
    billDiscountReason: z.string().nullable(),
    grandTotal: paise,
    balance: paise.openapi({ description: 'The grand total while open; nothing once it is not.' }),
    notes: z.string().nullable(),
    termsId: uuid.nullable(),
    termsSnapshot: termsSnapshot.nullable(),
    status: z.enum(ESTIMATE_STATUSES),
    convertedToType: z.enum(['sales_order', 'invoice']).nullable(),
    convertedToId: uuid.nullable(),
    convertedToNumber: z.string().nullable().optional(),
    convertedAt: timestamp.nullable(),
    cancelledReason: z.string().nullable(),
    createdAt: timestamp,
    lines: z.array(line).optional(),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/estimates',
  tags: ['Estimates'],
  summary: 'Create an estimate / quotation',
  description: [
    'Needs the `sales_orders` plan feature. An estimate is an offer: it moves no stock, issues no GST',
    'document and records no payment. It takes its number from the `estimate` series (`EST/26-27/0001`).',
    '',
    '`termsId` must be a T&C applicable to `estimate`. An estimate may have no items and a typed',
    '`manualTotal`. The device sends `expectedTotals`, re-checked on the server (`TOTALS_MISMATCH`).',
    'The discount policy is enforced when the estimate is converted to a sales order.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createEstimateBody } } } },
  responses: {
    201: jsonResponse('Created.', z.object({ data: estimate, replayed: z.boolean() })),
    200: jsonResponse(
      'Already created; the stored estimate is returned.',
      z.object({ data: estimate, replayed: z.boolean() }),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/estimates',
  tags: ['Estimates'],
  summary: 'Estimates',
  description:
    '`status=open` is estimates still to be won; `status=closed` is everything no longer open (converted, closed by hand, cancelled). `q` matches the number, customer name or phone.',
  security: accessTokenSecurity,
  request: { query: listEstimatesQuery },
  responses: { 200: jsonResponse('Newest first.', pageEnvelope(estimate)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/estimates/summary',
  tags: ['Estimates'],
  summary: 'Estimate counts by status',
  security: accessTokenSecurity,
  request: { query: summaryEstimatesQuery },
  responses: {
    200: jsonResponse(
      'Counts for the filter chips.',
      dataEnvelope(
        z.object({ all: z.number().int(), open: z.number().int(), closed: z.number().int() }),
      ),
    ),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/estimates/{id}',
  tags: ['Estimates'],
  summary: 'One estimate',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Estimate.', dataEnvelope(estimate)), ...errorResponses() },
});

registry.registerPath({
  method: 'put',
  path: '/v1/estimates/{id}',
  tags: ['Estimates'],
  summary: 'Edit an estimate',
  description:
    'Replaces the header and lines in one transaction. Only an open estimate can be edited: a converted one is the origin of another document (`ESTIMATE_ALREADY_CONVERTED`), and a closed or cancelled one is final (`ESTIMATE_NOT_OPEN`).',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: updateEstimateBody } } },
  },
  responses: {
    200: jsonResponse('Updated.', z.object({ data: estimate })),
    ...errorResponses(409, 422),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/estimates/{id}',
  tags: ['Estimates'],
  summary: 'Delete an estimate',
  description:
    'Hides the estimate; its number stays accounted for. A converted estimate cannot be deleted (`ESTIMATE_ALREADY_CONVERTED`), since the document raised from it names it.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: { description: 'Deleted.' }, ...errorResponses(409) },
});

registry.registerPath({
  method: 'post',
  path: '/v1/estimates/{id}/cancel',
  tags: ['Estimates'],
  summary: 'Cancel an estimate',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: cancelEstimateBody } } },
  },
  responses: { 200: jsonResponse('Cancelled.', dataEnvelope(estimate)), ...errorResponses(409) },
});

registry.registerPath({
  method: 'post',
  path: '/v1/estimates/{id}/close',
  tags: ['Estimates'],
  summary: 'Close an estimate by hand',
  description: 'For a quote that was lost or has lapsed. It can no longer be edited or converted.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Closed.', dataEnvelope(estimate)), ...errorResponses(409) },
});

registry.registerPath({
  method: 'post',
  path: '/v1/estimates/{id}/convert',
  tags: ['Estimates'],
  summary: 'Convert an estimate to a sales order',
  description: [
    "Raises a sales order carrying the estimate's customer, items, quantities, prices, discounts, taxes",
    'and T&C, and marks the estimate `converted`, in one transaction. Needs `estimates:convert` and',
    '`sales_orders:create`. A second attempt is refused (`ESTIMATE_ALREADY_CONVERTED`).',
    '',
    'To convert to a sale, raise the invoice from the till with `estimateId` on `POST /v1/invoices`;',
    'the estimate is marked converted in the same transaction as the invoice.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: convertEstimateBody } } },
  },
  responses: {
    201: jsonResponse(
      'Converted.',
      z.object({
        data: estimate,
        salesOrder: z.object({ id: uuid, documentNumber: z.string() }),
        warnings: z.array(z.object({ code: z.string(), details: z.record(z.unknown()) })),
      }),
    ),
    ...errorResponses(409, 422),
  },
});
