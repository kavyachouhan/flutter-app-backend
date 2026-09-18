import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import {
  documentStatusSchema,
  errorResponses,
  supplyTypeSchema,
  taxModeSchema,
  tenderModeSchema,
  warningSchema,
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
  createInvoiceBody,
  discount,
  listInvoicesQuery,
  voidInvoiceBody,
} from './invoices.schemas.js';

export const discountSchema = registry.register('Discount', discount);

export const additionalChargeSchema = registry.register(
  'AdditionalCharge',
  z.object({
    id: z.string(),
    label: z.string(),
    amount: paise,
    taxable: z.boolean(),
    taxRatePercent: percent.optional(),
  }),
);

export const taxRateSummarySchema = registry.register(
  'TaxRateSummary',
  z.object({
    taxRatePercent: percent,
    taxableAmount: paise,
    cgst: paise,
    sgst: paise,
    igst: paise,
    cess: paise,
  }),
);

export const hsnSummarySchema = registry.register(
  'HsnSummary',
  z.object({
    hsnCode: z.string(),
    quantity,
    taxableAmount: paise,
    cgst: paise,
    sgst: paise,
    igst: paise,
    cess: paise,
  }),
);

export const invoiceLineSchema = registry.register(
  'InvoiceLine',
  z.object({
    id: uuid,
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
    billDiscountShare: paise,
    taxableAmount: paise,
    taxRatePercent: percent,
    cessRatePercent: percent,
    cgst: paise,
    sgst: paise,
    igst: paise,
    cess: paise,
    lineTotal: paise,
  }),
);

export const invoiceTenderSchema = registry.register(
  'InvoiceTender',
  z.object({
    id: uuid,
    kind: z.enum(['invoice_tender', 'receipt']),
    mode: tenderModeSchema,
    amount: paise.openapi({ description: 'Amount allocated to this invoice.' }),
    tenderedAmount: paise.nullable(),
    reference: z.string().nullable(),
    receivedAt: timestamp,
    status: documentStatusSchema,
  }),
);

export const invoiceSummarySchema = registry.register(
  'InvoiceSummary',
  z.object({
    id: uuid,
    outletId: uuid,
    documentNumber: z.string(),
    documentDate: calendarDate,
    customerId: uuid.nullable(),
    customerName: z.string().nullable(),
    grandTotal: paise,
    amountPaid: paise,
    status: documentStatusSchema,
  }),
);

export const invoiceSchema = registry.register(
  'Invoice',
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
    customerId: uuid.nullable(),
    customerName: z.string().nullable(),
    customerGstin: z.string().nullable(),
    supplierGstin: z.string().nullable(),
    supplierStateCode: z.string(),
    placeOfSupplyStateCode: z.string().nullable(),
    taxMode: taxModeSchema,
    supplyType: supplyTypeSchema,
    pricesIncludeTax: z.boolean(),
    roundOffEnabled: z.boolean(),
    grossAmount: paise,
    lineDiscountTotal: paise,
    billDiscount: discountSchema.nullable(),
    billDiscountAmount: paise,
    taxableAmount: paise,
    totalCgst: paise,
    totalSgst: paise,
    totalIgst: paise,
    totalCess: paise,
    totalTax: paise,
    taxableCharges: paise,
    nonTaxableCharges: paise,
    additionalCharges: z.array(additionalChargeSchema),
    subTotal: paise,
    roundOff: paise,
    grandTotal: paise,
    taxSummary: z.array(taxRateSummarySchema),
    hsnSummary: z.array(hsnSummarySchema),
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
    amountPaid: paise,
    outstanding: paise,
    lines: z.array(invoiceLineSchema),
    payments: z.array(invoiceTenderSchema),
  }),
);

const issued = z.object({
  data: invoiceSchema,
  warnings: z.array(warningSchema),
  replayed: z.boolean().openapi({ description: 'true when this id had already been uploaded.' }),
});

registry.registerPath({
  method: 'get',
  path: '/v1/invoices',
  tags: ['Invoices'],
  summary: 'List invoices',
  security: accessTokenSecurity,
  request: { query: listInvoicesQuery },
  responses: {
    200: jsonResponse('Invoices, newest first.', pageEnvelope(invoiceSummarySchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/invoices/{id}',
  tags: ['Invoices'],
  summary: 'Get an invoice with lines and tenders',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 200: jsonResponse('Invoice.', dataEnvelope(invoiceSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'post',
  path: '/v1/invoices',
  tags: ['Invoices'],
  summary: 'Issue an invoice (upload from a device)',
  description:
    'The number must come from a block leased to this device. Totals are recomputed and a disagreement is rejected with `TOTALS_MISMATCH`. Credit limit and stock conditions come back as `warnings`, never rejections.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createInvoiceBody } } } },
  responses: {
    201: jsonResponse('Issued.', issued),
    200: jsonResponse('Already issued earlier (replay).', issued),
    ...errorResponses(409, 422),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/invoices/{id}/void',
  tags: ['Invoices'],
  summary: 'Void an invoice',
  description: 'Reverses stock and khata entries; the number stays consumed.',
  security: accessTokenSecurity,
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: voidInvoiceBody } } },
  },
  responses: { 200: jsonResponse('Voided.', dataEnvelope(invoiceSchema)), ...errorResponses(409) },
});
registry.registerPath({
  method: 'post',
  path: '/v1/invoices/{id}/printed',
  tags: ['Invoices'],
  summary: 'Record a print',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Print count updated.', dataEnvelope(invoiceSchema)),
    ...errorResponses(),
  },
});
