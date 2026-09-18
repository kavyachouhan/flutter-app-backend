import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  noContent,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createCounterBody,
  createOutletBody,
  listCountersQuery,
  updateCounterBody,
  updateOutletBody,
} from './outlets.schemas.js';

export const outletSchema = registry.register(
  'Outlet',
  z.object({
    id: uuid,
    name: z.string(),
    code: z.string(),
    gstin: z.string().nullable(),
    stateCode: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    pincode: z.string().nullable(),
    phone: z.string().nullable(),
    isActive: z.boolean(),
    isDefault: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

export const counterSchema = registry.register(
  'Counter',
  z.object({
    id: uuid,
    outletId: uuid,
    name: z.string(),
    code: z.string(),
    isActive: z.boolean(),
    isDefault: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

const body = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });

registry.registerPath({
  method: 'get',
  path: '/v1/outlets',
  tags: ['Outlets'],
  summary: 'List outlets',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Outlets.', dataEnvelope(z.array(outletSchema))),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/outlets',
  tags: ['Outlets'],
  summary: 'Create an outlet',
  security: accessTokenSecurity,
  request: { body: body(createOutletBody) },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(outletSchema)),
    ...errorResponses(402, 409),
  },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/outlets/{id}',
  tags: ['Outlets'],
  summary: 'Update an outlet',
  description: 'The code cannot change while a document series prints it.',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(updateOutletBody) },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(outletSchema)), ...errorResponses(409) },
});
registry.registerPath({
  method: 'delete',
  path: '/v1/outlets/{id}',
  tags: ['Outlets'],
  summary: 'Delete an outlet',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 204: noContent('Deleted.'), ...errorResponses(409) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/counters',
  tags: ['Outlets'],
  summary: 'List counters',
  security: accessTokenSecurity,
  request: { query: listCountersQuery },
  responses: {
    200: jsonResponse('Counters.', dataEnvelope(z.array(counterSchema))),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/counters',
  tags: ['Outlets'],
  summary: 'Create a counter',
  security: accessTokenSecurity,
  request: { body: body(createCounterBody) },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(counterSchema)),
    ...errorResponses(402, 409),
  },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/counters/{id}',
  tags: ['Outlets'],
  summary: 'Update a counter',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(updateCounterBody) },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(counterSchema)), ...errorResponses(409) },
});
registry.registerPath({
  method: 'delete',
  path: '/v1/counters/{id}',
  tags: ['Outlets'],
  summary: 'Delete a counter',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 204: noContent('Deleted.'), ...errorResponses(409) },
});
