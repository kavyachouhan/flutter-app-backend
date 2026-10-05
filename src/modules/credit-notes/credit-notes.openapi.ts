import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import {
  documentStatusSchema,
  errorResponses,
  supplyCategorySchema,
  supplyTypeSchema,
  taxModeSchema,
} from '../../openapi/common.js';
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
import {
  discountSchema,
  hsnSummarySchema,
  taxRateSummarySchema,
} from '../invoices/invoices.openapi.js';
import { paymentSchema } from '../payments/payments.openapi.js';
import {
  CREDIT_NOTE_REASONS,
  REFUND_MODES,
  createCreditNoteBody,
  listCreditNotesQuery,
  voidCreditNoteBody,
} from './credit-notes.schemas.js';

export const creditNoteReasonSchema = registry.register(
  'CreditNoteReason',
  z.enum(CREDIT_NOTE_REASONS),
);
export const refundModeSchema = registry.register('RefundMode', z.enum(REFUND_MODES));

export const creditNoteLineSchema = registry.register(
  'CreditNoteLine',
  z.object({
    id: uuid,
    invoiceLineId: uuid,
    lineNo: z.number().int(),
    itemId: uuid.nullable(),
    itemName: z.string(),
    hsnCode: z.string().nullable(),
    unit: z.string().nullable(),
    quantity,
    unitPrice: paise,
    discount: discountSchema.nullable(),
    grossAmount: paise,
    lineDiscount: paise,
    taxableAmount: paise,
    taxRatePercent: percent,
    cessRatePercent: percent,
    cgst: paise,
    sgst: paise,
    igst: paise,
    cess: paise,
    lineTotal: paise,
    supplyCategory: supplyCategorySchema,
  }),
);

export const creditNoteSummarySchema = registry.register(
  'CreditNoteSummary',
  z.object({
    id: uuid,
    outletId: uuid,
    documentNumber: z.string(),
    documentDate: calendarDate,
    originalInvoiceId: uuid,
    originalDocumentNumber: z.string(),
    customerId: uuid.nullable(),
    customerName: z.string().nullable(),
    grandTotal: paise,
    refundMode: refundModeSchema,
    status: documentStatusSchema,
  }),
);

export const creditNoteSchema = registry.register(
  'CreditNote',
  z.object({
    id: uuid,
    outletId: uuid,
    counterId: uuid.nullable(),
    deviceId: uuid,
    seriesId: uuid,
    sequenceNo: z.number().int(),
    documentNumber: z.string(),
    documentDate: calendarDate,
    fyStartYear: z.number().int(),
    originalInvoiceId: uuid,
    originalDocumentNumber: z.string(),
    customerId: uuid.nullable(),
    customerName: z.string().nullable(),
    customerGstin: z.string().nullable(),
    supplierGstin: z.string().nullable(),
    supplierStateCode: z.string(),
    placeOfSupplyStateCode: z.string().nullable(),
    taxMode: taxModeSchema,
    supplyType: supplyTypeSchema,
    isReverseCharge: z.boolean(),
    pricesIncludeTax: z.boolean(),
    roundOffEnabled: z.boolean(),
    grossAmount: paise,
    lineDiscountTotal: paise,
    billDiscountAmount: paise,
    taxableAmount: paise,
    totalCgst: paise,
    totalSgst: paise,
    totalIgst: paise,
    totalCess: paise,
    totalTax: paise,
    subTotal: paise,
    roundOff: paise,
    grandTotal: paise,
    taxSummary: z.array(taxRateSummarySchema),
    hsnSummary: z.array(hsnSummarySchema),
    reasonCode: creditNoteReasonSchema,
    refundMode: refundModeSchema,
    refundAmount: paise,
    restock: z.boolean(),
    customFields: z.record(z.string()).nullable(),
    notes: z.string().nullable(),
    status: documentStatusSchema,
    issuedAt: timestamp,
    issuedBy: uuid,
    voidReason: z.string().nullable(),
    voidedAt: timestamp.nullable(),
    voidedBy: uuid.nullable(),
    printCount: z.number().int(),
    printedAt: timestamp.nullable(),
    createdAt: timestamp,
    lines: z.array(creditNoteLineSchema),
    refund: paymentSchema.omit({ allocations: true }).nullable(),
  }),
);

export const returnableSchema = registry.register(
  'ReturnableInvoice',
  z.object({
    invoiceId: uuid,
    documentNumber: z.string(),
    status: documentStatusSchema,
    returnable: z.boolean(),
    lines: z.array(
      z.object({
        invoiceLineId: uuid,
        lineNo: z.number().int(),
        itemId: uuid.nullable(),
        itemName: z.string(),
        unit: z.string().nullable(),
        unitPrice: paise,
        soldQuantity: quantity,
        returnedQuantity: quantity,
        returnableQuantity: quantity,
      }),
    ),
  }),
);

const issued = z.object({ data: creditNoteSchema, replayed: z.boolean() });

registry.registerPath({
  method: 'get',
  path: '/v1/invoices/{id}/returnable',
  tags: ['Credit notes'],
  summary: 'What can still be returned on an invoice',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Per-line returnable quantities.', dataEnvelope(returnableSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/credit-notes',
  tags: ['Credit notes'],
  summary: 'List credit notes',
  security: accessTokenSecurity,
  request: { query: listCreditNotesQuery },
  responses: {
    200: jsonResponse('Credit notes, newest first.', pageEnvelope(creditNoteSummarySchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/credit-notes/{id}',
  tags: ['Credit notes'],
  summary: 'Get a credit note',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Credit note.', dataEnvelope(creditNoteSchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/credit-notes',
  tags: ['Credit notes'],
  summary: 'Issue a credit note against an invoice',
  description:
    'Lines reference the original invoice lines; prices, rates and discounts are derived from them (see the shared `deriveReturnLine` rule). Restocks unless `restock=false` (default false for `damaged`). `refundMode=khata` credits the customer; a tender mode pays out now. Requires the `credit_notes` feature.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createCreditNoteBody } } } },
  responses: {
    201: jsonResponse('Issued.', issued),
    200: jsonResponse('Already issued earlier (replay).', issued),
    ...errorResponses(402, 409, 422),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/credit-notes/{id}/void',
  tags: ['Credit notes'],
  summary: 'Void a credit note',
  security: accessTokenSecurity,
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: voidCreditNoteBody } } },
  },
  responses: {
    200: jsonResponse('Voided.', dataEnvelope(creditNoteSchema)),
    ...errorResponses(409),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/credit-notes/{id}/printed',
  tags: ['Credit notes'],
  summary: 'Record a print',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Print count updated.', dataEnvelope(creditNoteSchema)),
    ...errorResponses(),
  },
});
