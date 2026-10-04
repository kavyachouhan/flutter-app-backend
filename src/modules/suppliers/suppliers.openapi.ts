import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  noContent,
  pageEnvelope,
  paise,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createSupplierBody,
  listSuppliersQuery,
  supplierStatementQuery,
  updateSupplierBody,
} from './suppliers.schemas.js';

const supplier = registry.register(
  'Supplier',
  z.object({
    id: uuid,
    name: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    gstin: z.string().nullable(),
    stateCode: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    pincode: z.string().nullable(),
    paymentTermsDays: z.number().int().nullable(),
    leadTimeDays: z.number().int().nullable(),
    notes: z.string().nullable(),
    isActive: z.boolean(),
    balance: paise.openapi({
      description:
        'Positive means the shop owes the supplier — the opposite sign convention from a customer balance, where positive means the customer owes the shop.',
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

const ledgerEntry = registry.register(
  'SupplierLedgerEntry',
  z.object({
    id: uuid,
    entryType: z.enum([
      'opening_balance',
      'purchase',
      'purchase_void',
      'payment',
      'payment_void',
      'debit_note',
      'debit_note_void',
    ]),
    debit: paise.openapi({ description: 'Reduces what the shop owes.' }),
    credit: paise.openapi({ description: 'Increases what the shop owes.' }),
    referenceType: z.string().nullable(),
    referenceId: uuid.nullable(),
    occurredAt: timestamp,
    note: z.string().nullable(),
    runningBalance: paise,
  }),
);

const ageing = registry.register(
  'PayablesAgeing',
  z.object({
    buckets: z.array(z.string()),
    suppliers: z.array(
      z.object({
        supplierId: uuid,
        supplierName: z.string(),
        buckets: z.record(z.string(), paise),
        total: paise,
      }),
    ),
    total: paise,
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/suppliers',
  tags: ['Suppliers'],
  summary: 'Supplier master',
  security: accessTokenSecurity,
  request: { query: listSuppliersQuery },
  responses: { 200: jsonResponse('Suppliers.', pageEnvelope(supplier)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/suppliers',
  tags: ['Suppliers'],
  summary: 'Add a supplier',
  description:
    'The id is client-generated, so a retried create returns the existing record rather than failing.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createSupplierBody } } } },
  responses: { 201: jsonResponse('Created.', dataEnvelope(supplier)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/suppliers/ageing',
  tags: ['Suppliers'],
  summary: 'Payables ageing',
  description:
    'Outstanding bills bucketed 0-30 / 31-60 / 61-90 / 90+, measured from the due date where the supplier has payment terms and from the bill date otherwise, against the shop’s own calendar day.',
  security: accessTokenSecurity,
  request: { query: z.object({ supplierId: uuid.optional() }) },
  responses: { 200: jsonResponse('Ageing.', dataEnvelope(ageing)), ...errorResponses() },
});

registry.registerPath({
  method: 'get',
  path: '/v1/suppliers/{id}',
  tags: ['Suppliers'],
  summary: 'One supplier',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Supplier.', dataEnvelope(supplier)), ...errorResponses() },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/suppliers/{id}',
  tags: ['Suppliers'],
  summary: 'Update a supplier',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: updateSupplierBody } } },
  },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(supplier)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/suppliers/{id}',
  tags: ['Suppliers'],
  summary: 'Remove a supplier',
  description: 'Refused while the supplier has a balance; settle it first.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: noContent('Removed.'), ...errorResponses(422) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/suppliers/{id}/statement',
  tags: ['Suppliers'],
  summary: 'Supplier ledger',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }), query: supplierStatementQuery },
  responses: {
    200: jsonResponse('Oldest first, with a running balance.', pageEnvelope(ledgerEntry)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/suppliers/{id}/outstanding-bills',
  tags: ['Suppliers'],
  summary: 'Bills still owed, oldest first',
  description: 'The order to pay them in, and what a payment screen allocates against.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse(
      'Outstanding bills.',
      dataEnvelope(
        z.array(
          z.object({
            id: uuid,
            documentNumber: z.string(),
            supplierInvoiceNo: z.string(),
            documentDate: calendarDate,
            dueDate: calendarDate.nullable(),
            grandTotal: paise,
            outstanding: paise,
          }),
        ),
      ),
    ),
    ...errorResponses(),
  },
});
