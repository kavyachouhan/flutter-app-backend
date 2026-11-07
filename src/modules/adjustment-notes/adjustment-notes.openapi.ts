import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { errorResponses } from '../../openapi/common.js';
import { accessTokenSecurity, dataEnvelope, jsonResponse, pageEnvelope, registry } from '../../openapi/registry.js';
import {
  createFinancialCreditNoteBody,
  createSalesDebitNoteBody,
  listNotesQuery,
  voidNoteBody,
} from './adjustment-notes.schemas.js';

const body = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });
const note = z.record(z.unknown());

for (const [path, tag, summary, description, create] of [
  [
    '/v1/sales-debit-notes',
    'Sales debit notes',
    'sales debit note',
    'Adds value or tax to an issued invoice (s.34(3)), in its own series. Parties and place of supply come from the invoice. Adds to the khata.',
    createSalesDebitNoteBody,
  ],
  [
    '/v1/financial-credit-notes',
    'Financial credit notes',
    'financial credit note',
    'A commercial credit with no tax, in its own series. Credits the khata and never reaches a return.',
    createFinancialCreditNoteBody,
  ],
] as const) {
  registry.registerPath({
    method: 'get',
    path,
    tags: [tag],
    summary: `List ${summary}s`,
    security: accessTokenSecurity,
    request: { query: listNotesQuery },
    responses: { 200: jsonResponse('A page of notes.', pageEnvelope(note)), ...errorResponses(401, 403) },
  });
  registry.registerPath({
    method: 'post',
    path,
    tags: [tag],
    summary: `Issue a ${summary}`,
    description,
    security: accessTokenSecurity,
    request: { body: body(create) },
    responses: {
      201: jsonResponse('Issued.', dataEnvelope(note)),
      200: jsonResponse('Already issued; replayed.', dataEnvelope(note)),
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  });
  registry.registerPath({
    method: 'get',
    path: `${path}/{id}`,
    tags: [tag],
    summary: `Get a ${summary}`,
    security: accessTokenSecurity,
    request: { params: idParams },
    responses: { 200: jsonResponse('The note.', dataEnvelope(note)), ...errorResponses(401, 403, 404) },
  });
  registry.registerPath({
    method: 'post',
    path: `${path}/{id}/void`,
    tags: [tag],
    summary: `Cancel a ${summary}`,
    security: accessTokenSecurity,
    request: { params: idParams, body: body(voidNoteBody) },
    responses: { 200: jsonResponse('Cancelled.', dataEnvelope(note)), ...errorResponses(400, 401, 403, 404, 422) },
  });
}
