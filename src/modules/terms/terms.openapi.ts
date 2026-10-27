import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  noContent,
  pageEnvelope,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createTermsBody,
  listTermsQuery,
  termsDocumentType,
  updateTermsBody,
} from './terms.schemas.js';

export const termsSnapshot = registry.register(
  'TermsSnapshot',
  z.object({ title: z.string(), description: z.string() }).openapi({
    description: 'The terms as they read when the document was issued.',
  }),
);

const terms = registry.register(
  'Terms',
  z.object({
    id: uuid,
    title: z.string(),
    description: z.string(),
    applicableFor: z.array(termsDocumentType),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/terms',
  tags: ['Terms & Conditions'],
  summary: 'Saved terms, optionally only those applicable to one document type',
  security: accessTokenSecurity,
  request: { query: listTermsQuery },
  responses: { 200: jsonResponse('Terms.', pageEnvelope(terms)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/terms',
  tags: ['Terms & Conditions'],
  summary: 'Add terms',
  description: 'The id is client-generated, so a retried create returns the existing record.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createTermsBody } } } },
  responses: { 201: jsonResponse('Created.', dataEnvelope(terms)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'get',
  path: '/v1/terms/{id}',
  tags: ['Terms & Conditions'],
  summary: 'One set of terms',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Terms.', dataEnvelope(terms)), ...errorResponses() },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/terms/{id}',
  tags: ['Terms & Conditions'],
  summary: 'Update terms',
  description: 'Documents already issued keep the text they were issued with.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: updateTermsBody } } },
  },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(terms)), ...errorResponses(422) },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/terms/{id}',
  tags: ['Terms & Conditions'],
  summary: 'Remove terms',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: noContent('Removed.'), ...errorResponses() },
});
