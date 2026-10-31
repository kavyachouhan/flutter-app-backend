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
  cancelProformaInvoiceBody,
  createProformaInvoiceBody,
  PROFORMA_INVOICE_STATUSES,
  listProformaInvoicesQuery,
  summaryProformaInvoicesQuery,
  updateProformaInvoiceBody,
} from './proforma-invoices.schemas.js';

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

const proformaInvoice = registry.register(
  'ProformaInvoice',
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
    status: z.enum(PROFORMA_INVOICE_STATUSES),
    isExpired: z.boolean().openapi({
      description: 'Open and past `validUntil` in the shop time zone. Derived, never stored.',
    }),
    effectiveStatus: z
      .enum(['open', 'converted', 'closed', 'cancelled', 'expired'])
      .openapi({ description: '`expired` stands in for an open document past its validity.' }),
    convertedToType: z.literal('invoice').nullable(),
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
  path: '/v1/proforma-invoices',
  tags: ['Proforma Invoices'],
  summary: 'Create a proforma invoice',
  description: [
    'Needs the `sales_orders` plan feature. A proforma invoice is preliminary: it moves no stock, issues no GST',
    'invoice and records no payment or revenue. It takes its number from the `proforma_invoice` series (`PI/26-27/0001`).',
    '',
    '`termsId` must be a T&C applicable to `proforma_invoice`. A proforma invoice may have no items and a typed',
    '`manualTotal`. The device sends `expectedTotals`, re-checked on the server (`TOTALS_MISMATCH`).',
    'It becomes an invoice when the till raises one with `proformaInvoiceId` on `POST /v1/invoices`.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createProformaInvoiceBody } } } },
  responses: {
    201: jsonResponse('Created.', z.object({ data: proformaInvoice, replayed: z.boolean() })),
    200: jsonResponse(
      'Already created; the stored proforma invoice is returned.',
      z.object({ data: proformaInvoice, replayed: z.boolean() }),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/proforma-invoices',
  tags: ['Proforma Invoices'],
  summary: 'Proforma invoices',
  description:
    '`status=open` is proforma invoices still to be won; `status=closed` is everything no longer open (converted, closed by hand, cancelled, or past `validUntil`). `q` matches the number, customer name or phone.',
  security: accessTokenSecurity,
  request: { query: listProformaInvoicesQuery },
  responses: { 200: jsonResponse('Newest first.', pageEnvelope(proformaInvoice)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/proforma-invoices/summary',
  tags: ['Proforma Invoices'],
  summary: 'Proforma invoice counts by status',
  security: accessTokenSecurity,
  request: { query: summaryProformaInvoicesQuery },
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
  path: '/v1/proforma-invoices/{id}',
  tags: ['Proforma Invoices'],
  summary: 'One proforma invoice',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Proforma invoice.', dataEnvelope(proformaInvoice)), ...errorResponses() },
});

registry.registerPath({
  method: 'put',
  path: '/v1/proforma-invoices/{id}',
  tags: ['Proforma Invoices'],
  summary: 'Edit a proforma invoice',
  description:
    'Replaces the header and lines in one transaction. Only an open proforma invoice can be edited: a converted one is the origin of another document (`PROFORMA_INVOICE_ALREADY_CONVERTED`), and a closed or cancelled one is final (`PROFORMA_INVOICE_NOT_OPEN`).',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: updateProformaInvoiceBody } } },
  },
  responses: {
    200: jsonResponse('Updated.', z.object({ data: proformaInvoice })),
    ...errorResponses(409, 422),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/proforma-invoices/{id}',
  tags: ['Proforma Invoices'],
  summary: 'Delete a proforma invoice',
  description:
    'Hides the proforma invoice; its number stays accounted for. A converted proforma invoice cannot be deleted (`PROFORMA_INVOICE_ALREADY_CONVERTED`), since the document raised from it names it.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: { description: 'Deleted.' }, ...errorResponses(409) },
});

registry.registerPath({
  method: 'post',
  path: '/v1/proforma-invoices/{id}/cancel',
  tags: ['Proforma Invoices'],
  summary: 'Cancel a proforma invoice',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: cancelProformaInvoiceBody } } },
  },
  responses: { 200: jsonResponse('Cancelled.', dataEnvelope(proformaInvoice)), ...errorResponses(409) },
});

registry.registerPath({
  method: 'post',
  path: '/v1/proforma-invoices/{id}/close',
  tags: ['Proforma Invoices'],
  summary: 'Close a proforma invoice by hand',
  description: 'For a proforma invoice that was lost or has lapsed. It can no longer be edited or invoiced.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Closed.', dataEnvelope(proformaInvoice)), ...errorResponses(409) },
});
