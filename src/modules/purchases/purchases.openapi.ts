import { z } from 'zod';
import { errorResponses, supplyCategorySchema } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  pageEnvelope,
  paise,
  percent,
  quantity,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { termsSnapshot } from '../terms/terms.openapi.js';
import {
  cancelPurchaseOrderBody,
  createPurchaseBillBody,
  createPurchaseOrderBody,
  createSupplierPaymentBody,
  listPurchaseBillsQuery,
  listPurchaseOrdersQuery,
  listSupplierPaymentsQuery,
  voidPurchaseBillBody,
  voidSupplierPaymentBody,
} from './purchases.schemas.js';

const billLine = registry.register(
  'PurchaseBillLine',
  z.object({
    id: uuid,
    lineNo: z.number().int(),
    itemId: uuid,
    itemName: z.string(),
    hsnCode: z.string().nullable(),
    unit: z.string().nullable(),
    quantity,
    unitPrice: paise,
    taxableAmount: paise,
    taxRatePercent: percent,
    cgst: paise,
    sgst: paise,
    igst: paise,
    cess: paise,
    lineTotal: paise,
    supplyCategory: supplyCategorySchema,
    landedCostShare: paise.openapi({ description: 'Freight apportioned to this line.' }),
    effectiveUnitCost: paise.openapi({
      description:
        'Paise per whole unit, landed and net of reclaimable tax. The figure that moved this item’s average cost.',
    }),
  }),
);

const bill = registry.register(
  'PurchaseBill',
  z.object({
    id: uuid,
    outletId: uuid,
    supplierId: uuid,
    purchaseOrderId: uuid.nullable(),
    documentNumber: z.string().openapi({ description: 'Ours, from the series.' }),
    supplierInvoiceNo: z.string().openapi({ description: 'Theirs, from the paper.' }),
    supplierInvoiceDate: calendarDate,
    documentDate: calendarDate,
    dueDate: calendarDate.nullable(),
    itcEligible: z.boolean(),
    taxableAmount: paise,
    totalTax: paise,
    grandTotal: paise,
    amountPaid: paise,
    returnedAmount: paise,
    outstanding: paise,
    freightAmount: paise,
    landedCostBasis: z.enum(['value', 'quantity', 'none']),
    termsId: uuid.nullable(),
    termsSnapshot: termsSnapshot.nullable(),
    status: z.enum(['issued', 'void']),
    receivedAt: timestamp,
    lines: z.array(billLine),
  }),
);

const billSummary = registry.register(
  'PurchaseBillSummary',
  z.object({
    id: uuid,
    outletId: uuid,
    supplierId: uuid,
    supplierName: z.string(),
    documentNumber: z.string(),
    supplierInvoiceNo: z.string(),
    documentDate: calendarDate,
    dueDate: calendarDate.nullable(),
    grandTotal: paise,
    amountPaid: paise,
    status: z.enum(['issued', 'void']),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/purchase-bills',
  tags: ['Purchases'],
  summary: 'Record a supplier bill',
  description: [
    'One transaction: stock in, item cost moved, payable created.',
    '',
    '**Cost.** The landed rate — supplier price, plus freight apportioned per `landedCostBasis`,',
    'minus GST that will be reclaimed — folds into a moving weighted average per item per outlet.',
    'Later sales snapshot that average onto the invoice line, which is what makes margin a',
    'historical fact rather than a figure recomputed against today’s prices.',
    '',
    '**Input tax credit.** `itcEligible` decides whether the GST is capitalised into stock cost.',
    'It is forced false for an unregistered or composition business, which never reclaims.',
    '',
    '**Double entry.** Re-entering the same `supplierInvoiceNo` for a supplier in the same',
    'financial year answers `DUPLICATE_SUPPLIER_INVOICE` and names the existing document.',
    '',
    'A bill cannot be edited — it moved stock and cost that later sales have consumed. Void and',
    're-enter instead.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createPurchaseBillBody } } } },
  responses: {
    201: jsonResponse('Recorded.', dataEnvelope(bill)),
    200: jsonResponse('Already recorded; the stored bill is returned.', dataEnvelope(bill)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/purchase-bills',
  tags: ['Purchases'],
  summary: 'Purchase bills',
  security: accessTokenSecurity,
  request: { query: listPurchaseBillsQuery },
  responses: {
    200: jsonResponse('Newest first.', pageEnvelope(billSummary)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/purchase-bills/{id}',
  tags: ['Purchases'],
  summary: 'One purchase bill',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Bill.', dataEnvelope(bill)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/purchase-bills/{id}/returnable',
  tags: ['Purchases'],
  summary: 'What can still be returned',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse(
      'Lines with the quantity already returned deducted.',
      dataEnvelope(
        z.object({
          purchaseBillId: uuid,
          documentNumber: z.string(),
          returnable: z.boolean(),
          lines: z.array(
            z.object({
              id: uuid,
              itemId: uuid,
              itemName: z.string(),
              quantity,
              returnedQuantity: quantity,
              returnableQuantity: quantity,
              unitPrice: paise,
            }),
          ),
        }),
      ),
    ),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/purchase-bills/{id}/void',
  tags: ['Purchases'],
  summary: 'Void a purchase bill',
  description:
    'Reverses stock, cost and the payable. Refused while payments or debit notes exist against the bill. The cost reversal is exact only if nothing has been sold since: once the blended average has been consumed by sales no arithmetic restores the prior figure, so it approximates.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: voidPurchaseBillBody } } },
  },
  responses: { 200: jsonResponse('Voided.', dataEnvelope(bill)), ...errorResponses(422) },
});

// --- Purchase orders -------------------------------------------------------

const order = registry.register(
  'PurchaseOrder',
  z.object({
    id: uuid,
    outletId: uuid,
    supplierId: uuid,
    supplierName: z.string(),
    documentNumber: z.string(),
    documentDate: calendarDate,
    expectedDate: calendarDate.nullable(),
    status: z.enum(['draft', 'sent', 'partial', 'received', 'cancelled']),
    estimatedTotal: paise,
    notes: z.string().nullable(),
    termsId: uuid.nullable(),
    termsSnapshot: termsSnapshot.nullable(),
    lines: z
      .array(
        z.object({
          id: uuid,
          lineNo: z.number().int(),
          itemId: uuid,
          itemName: z.string(),
          unit: z.string().nullable(),
          quantityOrdered: quantity,
          quantityReceived: quantity,
          quantityPending: quantity,
          expectedUnitCost: paise,
        }),
      )
      .optional(),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/purchase-orders',
  tags: ['Purchases'],
  summary: 'Raise a purchase order',
  description:
    'An order moves no stock and creates no payable. Receive against it by passing `purchaseOrderId` and per-line `purchaseOrderLineId` on a purchase bill; partial receipt is the normal case and the status follows the lines.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createPurchaseOrderBody } } } },
  responses: { 201: jsonResponse('Raised.', dataEnvelope(order)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/purchase-orders',
  tags: ['Purchases'],
  summary: 'Purchase orders',
  security: accessTokenSecurity,
  request: { query: listPurchaseOrdersQuery },
  responses: { 200: jsonResponse('Newest first.', pageEnvelope(order)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/purchase-orders/{id}',
  tags: ['Purchases'],
  summary: 'One purchase order',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Order.', dataEnvelope(order)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/purchase-orders/{id}/cancel',
  tags: ['Purchases'],
  summary: 'Cancel a purchase order',
  description:
    'Refused once anything has been received against it: those goods and their bill are real, and an order marked cancelled while its lines show receipts would misdescribe what happened.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: cancelPurchaseOrderBody } } },
  },
  responses: { 200: jsonResponse('Cancelled.', dataEnvelope(order)), ...errorResponses(422) },
});

// --- Supplier payments -----------------------------------------------------

const payment = registry.register(
  'SupplierPayment',
  z.object({
    id: uuid,
    outletId: uuid,
    supplierId: uuid,
    mode: z.enum(['cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque']),
    amount: paise,
    allocatedAmount: paise.openapi({
      description: 'Of `amount`, how much is tied to bills. The remainder sits on account.',
    }),
    reference: z.string().nullable(),
    paidAt: timestamp,
    status: z.enum(['issued', 'void']),
    notes: z.string().nullable(),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/supplier-payments',
  tags: ['Purchases'],
  summary: 'Pay a supplier',
  description:
    'Allocations settle specific bills and are each checked against what is still outstanding on them. Omitting allocations leaves the money on account as an advance; either way the full amount reduces the supplier balance.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createSupplierPaymentBody } } } },
  responses: { 201: jsonResponse('Recorded.', dataEnvelope(payment)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/supplier-payments',
  tags: ['Purchases'],
  summary: 'Payments made to suppliers',
  security: accessTokenSecurity,
  request: { query: listSupplierPaymentsQuery },
  responses: { 200: jsonResponse('Newest first.', pageEnvelope(payment)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/supplier-payments/{id}/void',
  tags: ['Purchases'],
  summary: 'Void a supplier payment',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: voidSupplierPaymentBody } } },
  },
  responses: { 200: jsonResponse('Voided.', dataEnvelope(payment)), ...errorResponses(422) },
});
