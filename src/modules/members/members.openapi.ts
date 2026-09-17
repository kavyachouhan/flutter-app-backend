import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { errorResponses, roleSchema } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  noContent,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { addMemberBody, updateMemberBody } from './members.schemas.js';

export const memberSchema = registry.register(
  'Member',
  z.object({
    id: uuid,
    userId: uuid,
    name: z.string().nullable(),
    phone: z.string(),
    role: roleSchema,
    outletIds: z.array(uuid).nullable(),
    isActive: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

const body = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });

registry.registerPath({
  method: 'get',
  path: '/v1/members',
  tags: ['Members'],
  summary: 'List staff',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Members.', dataEnvelope(z.array(memberSchema))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/members',
  tags: ['Members'],
  summary: 'Add a staff member by phone',
  description: 'Counts against the plan’s user quota.',
  security: accessTokenSecurity,
  request: { body: body(addMemberBody) },
  responses: {
    201: jsonResponse('Added.', dataEnvelope(memberSchema)),
    ...errorResponses(402, 409),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/members/{id}',
  tags: ['Members'],
  summary: 'Change role, outlets or active state',
  security: accessTokenSecurity,
  request: { params: idParams, body: body(updateMemberBody) },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(memberSchema)), ...errorResponses(409) },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/members/{id}',
  tags: ['Members'],
  summary: 'Remove a staff member',
  description: 'The last owner cannot be removed (`LAST_OWNER`).',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 204: noContent('Removed.'), ...errorResponses(409) },
});
