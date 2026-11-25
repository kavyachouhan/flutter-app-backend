import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { documentStatusSchema, errorResponses, tenderModeSchema } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  pageEnvelope,
  paise,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  allocateReceiptBody,
  createReceiptBody,
  listPaymentsQuery,
  voidPaymentBody,
} from './payments.schemas.js';

export const paymentAllocationSchema = registry.register(
  'PaymentAllocation',
  z.object({ invoiceId: uuid, documentNumber: z.string(), amount: paise }),
);

export const paymentSchema = registry.register(
  'Payment',
  z.object({
    id: uuid,
    outletId: uuid,
    customerId: uuid.nullable(),
    kind: z.enum(['invoice_tender', 'receipt']),
    mode: tenderModeSchema,
    amount: paise,
    tenderedAmount: paise.nullable(),
    reference: z.string().nullable(),
    receivedAt: timestamp,
    receivedBy: uuid,
    status: documentStatusSchema,
    voidReason: z.string().nullable(),
    voidedAt: timestamp.nullable(),
    createdAt: timestamp,
    allocations: z.array(paymentAllocationSchema),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/payments',
  tags: ['Payments'],
  summary: 'List payments',
  security: accessTokenSecurity,
  request: { query: listPaymentsQuery },
  responses: { 200: jsonResponse('Payments.', pageEnvelope(paymentSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'get',
  path: '/v1/payments/{id}',
  tags: ['Payments'],
  summary: 'Get a payment',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 200: jsonResponse('Payment.', dataEnvelope(paymentSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'post',
  path: '/v1/payments',
  tags: ['Payments'],
  summary: 'Record a khata receipt',
  description:
    'Credits the customer ledger; allocations settle specific invoices and any remainder stays as an advance.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createReceiptBody } } } },
  responses: {
    201: jsonResponse('Recorded.', dataEnvelope(paymentSchema)),
    ...errorResponses(422),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/payments/{id}/void',
  tags: ['Payments'],
  summary: 'Void a receipt',
  security: accessTokenSecurity,
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: voidPaymentBody } } },
  },
  responses: { 200: jsonResponse('Voided.', dataEnvelope(paymentSchema)), ...errorResponses(409) },
});

registry.registerPath({
  method: 'post',
  path: '/v1/payments/{id}/allocations',
  tags: ['Payments'],
  summary: 'Settle invoices from an advance on a receipt',
  description:
    "Allocates the unallocated part of a khata receipt to the customer's invoices. No ledger entry is written; the receipt already credited the khata.",
  security: accessTokenSecurity,
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: allocateReceiptBody } } },
  },
  responses: {
    200: jsonResponse('Allocated.', dataEnvelope(paymentSchema)),
    ...errorResponses(422),
  },
});
