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
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createCustomerBody,
  ledgerQuery,
  listCustomersQuery,
  updateCustomerBody,
} from './customers.schemas.js';

export const customerSchema = registry.register(
  'Customer',
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
    creditLimit: paise.nullable(),
    notes: z.string().nullable(),
    balance: paise.openapi({ description: 'Owed by the customer; negative is an advance held.' }),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

export const ledgerEntrySchema = registry.register(
  'LedgerEntry',
  z.object({
    id: uuid,
    entryType: z.enum(['opening_balance', 'invoice', 'invoice_void', 'payment', 'payment_void']),
    debit: paise,
    credit: paise,
    referenceType: z.string().nullable(),
    referenceId: uuid.nullable(),
    occurredAt: timestamp,
    note: z.string().nullable(),
    runningBalance: paise,
  }),
);

const body = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });

registry.registerPath({
  method: 'get',
  path: '/v1/customers',
  tags: ['Customers'],
  summary: 'Search customers',
  security: accessTokenSecurity,
  request: { query: listCustomersQuery },
  responses: { 200: jsonResponse('Customers.', pageEnvelope(customerSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'get',
  path: '/v1/customers/{id}',
  tags: ['Customers'],
  summary: 'Get a customer',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 200: jsonResponse('Customer.', dataEnvelope(customerSchema)), ...errorResponses() },
});
registry.registerPath({
  method: 'get',
  path: '/v1/customers/{id}/ledger',
  tags: ['Customers'],
  summary: 'Khata statement',
  description: 'Newest first, with a running balance on each entry.',
  security: accessTokenSecurity,
  request: { params: idParams, query: ledgerQuery },
  responses: {
    200: jsonResponse('Statement.', pageEnvelope(ledgerEntrySchema)),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/customers',
  tags: ['Customers'],
  summary: 'Create a customer',
  security: accessTokenSecurity,
  request: { body: body(createCustomerBody) },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(customerSchema)),
    ...errorResponses(409),
  },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/customers/{id}',
  tags: ['Customers'],
  summary: 'Update a customer',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(updateCustomerBody) },
  responses: {
    200: jsonResponse('Updated.', dataEnvelope(customerSchema)),
    ...errorResponses(409),
  },
});
registry.registerPath({
  method: 'delete',
  path: '/v1/customers/{id}',
  tags: ['Customers'],
  summary: 'Delete a customer (soft)',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 204: noContent('Deleted.'), ...errorResponses(409) },
});
