import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  jsonResponse,
  pageEnvelope,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { listAuditQuery } from './audit.schemas.js';

export const auditEntrySchema = registry.register(
  'AuditEntry',
  z.object({
    id: z.string().openapi({ description: 'BIGSERIAL rendered as text; opaque to clients.' }),
    occurredAt: timestamp,
    userId: uuid.nullable(),
    deviceId: uuid.nullable(),
    ip: z.string().nullable(),
    action: z.string().openapi({ example: 'invoice.voided' }),
    entityType: z.string(),
    entityId: z.string().nullable(),
    changes: z
      .record(z.object({ from: z.unknown(), to: z.unknown() }))
      .nullable()
      .openapi({ description: 'Field-level diff for updates.' }),
    metadata: z.record(z.unknown()).nullable(),
    requestId: z.string().nullable(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/audit',
  tags: ['Audit'],
  summary: 'Audit log',
  security: accessTokenSecurity,
  request: { query: listAuditQuery },
  responses: {
    200: jsonResponse('Entries, newest first.', pageEnvelope(auditEntrySchema)),
    ...errorResponses(),
  },
});
