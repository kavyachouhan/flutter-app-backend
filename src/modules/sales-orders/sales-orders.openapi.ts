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
  cancelSaleOrderBody,
  closeSaleOrderBody,
  createSaleOrderBody,
  deleteSaleOrderQuery,
  listSaleOrdersQuery,
  summarySaleOrdersQuery,
  updateSaleOrderBody,
} from './sales-orders.schemas.js';

const line = z.object({
  id: uuid,
  lineNo: z.number().int(),
  itemId: uuid.nullable().openapi({ description: 'Null for a custom (non-catalogue) line.' }),
  itemName: z.string(),
  hsnCode: z.string().nullable(),
  unit: z.string().nullable(),
  quantity,
  quantityFulfilled: quantity,
  quantityPending: quantity,
  unitPrice: paise,
  taxableAmount: paise,
  lineTotal: paise,
});

const orderInvoice = z.object({
  id: uuid,
  documentNumber: z.string(),
  documentDate: calendarDate,
  grandTotal: paise,
  billDiscountAmount: paise,
  status: z.enum(['issued', 'void']),
  amendsInvoiceId: uuid.nullable(),
});

const order = registry.register(
  'SaleOrder',
  z.object({
    id: uuid,
    outletId: uuid,
    documentNumber: z.string(),
    documentDate: calendarDate,
    dueDate: calendarDate.nullable(),
    customerId: uuid.nullable(),
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    placeOfSupplyStateCode: z.string().nullable(),
    isReverseCharge: z.boolean(),
    taxableAmount: paise,
    totalTax: paise,
    billDiscount: z
      .object({ kind: z.enum(['amount', 'percent']), value: z.number() })
      .nullable(),
    billDiscountAmount: paise,
    billDiscountReason: z.string().nullable(),
    billDiscountRemaining: paise.openapi({
      description: 'What the bill-level discount still has to give to the next invoice.',
    }),
    grandTotal: paise,
    advanceAmount: paise,
    advanceRefunded: paise,
    advanceApplied: paise.openapi({ description: 'Counted toward invoices that still stand.' }),
    advanceRemaining: paise.openapi({
      description: 'Taken, less refunded, less applied: what a cancel would pay back.',
    }),
    balanceDue: paise,
    paymentMode: z.string().nullable(),
    notes: z.string().nullable(),
    termsId: uuid.nullable(),
    termsSnapshot: termsSnapshot.nullable(),
    status: z.enum(['open', 'partial', 'closed', 'cancelled']),
    createdAt: timestamp,
    invoices: z.array(orderInvoice),
    lines: z.array(line).optional(),
  }),
);

const refund = z
  .object({
    amount: paise,
    mode: z.string(),
    paidOut: z.boolean().openapi({ description: 'False when it was left as customer credit.' }),
  })
  .nullable();

const warnings = z.array(z.object({ code: z.string(), details: z.record(z.unknown()) }));

registry.registerPath({
  method: 'post',
  path: '/v1/sales-orders',
  tags: ['Sales orders'],
  summary: 'Take a sales order',
  description: [
    'Needs the `sales_orders` plan feature. An order moves no stock and issues no GST document.',
    'Fulfil it by raising invoices with `salesOrderId` and per-line `salesOrderLineId`; the status',
    'follows the lines.',
    '',
    '**Advance.** `advanceAmount` is recorded as a real payment and a khata credit. It never changes the',
    'status: taking money proves nothing was delivered. When an invoice is raised against the order, the',
    'unused advance is counted toward it.',
    '',
    '**Reservation.** Catalogue lines that track stock reserve their pending quantity. Asking for more than is',
    'available answers a `RESERVATION_SHORTFALL` warning, or is refused with `INSUFFICIENT_STOCK` when the',
    'business does not allow negative stock. Custom lines (no `itemId`) reserve nothing.',
    '',
    '**Discount.** A bill or line discount over the shop policy is refused (`DISCOUNT_CAP_EXCEEDED`) unless',
    '`discountApprovals` from someone holding the approver permission accompany it. A discount larger than',
    'what it is taken from is `VALIDATION_FAILED` with `DISCOUNT_EXCEEDS_TOTAL`.',
    '',
    'An order may have no items and a typed `manualTotal`.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createSaleOrderBody } } } },
  responses: {
    201: jsonResponse(
      'Taken.',
      z.object({ data: order, replayed: z.boolean(), warnings }),
    ),
    200: jsonResponse(
      'Already taken; the stored order is returned.',
      z.object({ data: order, replayed: z.boolean(), warnings }),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/sales-orders',
  tags: ['Sales orders'],
  summary: 'Sales orders',
  description: '`q` matches the order number, customer name or phone.',
  security: accessTokenSecurity,
  request: { query: listSaleOrdersQuery },
  responses: { 200: jsonResponse('Newest first.', pageEnvelope(order)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/sales-orders/summary',
  tags: ['Sales orders'],
  summary: 'Order counts by status',
  security: accessTokenSecurity,
  request: { query: summarySaleOrdersQuery },
  responses: {
    200: jsonResponse(
      'Counts for the filter chips.',
      dataEnvelope(
        z.object({
          all: z.number().int(),
          open: z.number().int(),
          partial: z.number().int(),
          closed: z.number().int(),
        }),
      ),
    ),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/sales-orders/{id}',
  tags: ['Sales orders'],
  summary: 'One sales order',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Order.', dataEnvelope(order)), ...errorResponses() },
});

registry.registerPath({
  method: 'put',
  path: '/v1/sales-orders/{id}',
  tags: ['Sales orders'],
  summary: 'Edit a sales order',
  description: [
    'Replaces the header and lines in one transaction. Owner-only (`sales_orders:update`).',
    '',
    'A line already invoiced keeps the item, price, tax and discount it was invoiced at',
    '(`ORDER_LINE_INVOICED`): those figures are on issued invoices, so change them by amending the invoice.',
    'Its quantity can go up, or down as far as what has been invoiced. A line already invoiced cannot be',
    'removed. A closed order can be edited; adding something to deliver re-opens it. A cancelled order',
    'cannot. The advance cannot be changed once it has been applied to an invoice or refunded',
    '(`ADVANCE_LOCKED`).',
  ].join('\n'),
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: updateSaleOrderBody } } },
  },
  responses: {
    200: jsonResponse('Updated.', z.object({ data: order, warnings })),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/sales-orders/{id}',
  tags: ['Sales orders'],
  summary: 'Delete a sales order',
  description:
    'Owner-only. Hides the order and gives back its reservation. An advance that has not been used is paid back first, the way it was taken unless `refundMode` says otherwise (`khata` leaves it as customer credit): it may already be banked, so it is refunded rather than un-recorded. Answers 200 with the refund when there was one, otherwise 204. Refused once anything has been invoiced against it.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }), query: deleteSaleOrderQuery },
  responses: {
    204: { description: 'Deleted.' },
    200: jsonResponse(
      'Deleted, with the advance refunded.',
      dataEnvelope(z.object({ deleted: z.boolean(), refund })),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/sales-orders/{id}/cancel',
  tags: ['Sales orders'],
  summary: 'Cancel a sales order',
  description:
    'Refused once anything has been invoiced; close the order instead. Gives back the reservation. An unused advance is paid back the way it was taken unless `refundMode` says otherwise; the response carries what was refunded. Needs `sales_orders:cancel`.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: cancelSaleOrderBody } } },
  },
  responses: {
    200: jsonResponse('Cancelled.', z.object({ data: order, refund })),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/sales-orders/{id}/close',
  tags: ['Sales orders'],
  summary: 'Close a sales order by hand',
  description:
    'For an order the customer took less of. What was not delivered stops being reserved. An unused advance stays as customer credit unless `refundMode` pays it out. Needs `sales_orders:cancel`.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: closeSaleOrderBody } } },
  },
  responses: {
    200: jsonResponse('Closed.', z.object({ data: order, refund })),
    ...errorResponses(422),
  },
});
