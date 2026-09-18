import { z } from 'zod';
import { errorCodeSchema, errorResponses, warningSchema } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { numberBlockSchema } from '../numbering/numbering.openapi.js';
import { SYNC_ENTITIES } from './sync.registry.js';
import { OPERATION_TYPES, pullQuery, pushBody } from './sync.schemas.js';

export const syncEntitySchema = registry.register(
  'SyncEntity',
  z.enum(SYNC_ENTITIES as [string, ...string[]]),
);
export const syncOperationTypeSchema = registry.register(
  'SyncOperationType',
  z.enum(OPERATION_TYPES),
);

export const syncChangeSchema = registry.register(
  'SyncChange',
  z.object({
    entity: syncEntitySchema,
    op: z.enum(['upsert', 'delete']),
    serverSeq: z.number().int(),
    row: z.record(z.unknown()).openapi({
      description:
        'The full row in camelCase, the same shape the REST endpoint for that entity returns (plus `serverSeq`, `deletedAt`). Balances and ledgers are included; apply upserts by key.',
    }),
  }),
);

export const pullResultSchema = registry.register(
  'SyncPullResult',
  z.object({
    changes: z.array(syncChangeSchema),
    nextSince: z.number().int().openapi({
      description:
        'Send as `since` on the next pull once every change is applied. Equal to `since` when nothing changed.',
    }),
    hasMore: z.boolean(),
    leases: z
      .array(numberBlockSchema)
      .openapi({ description: 'Blocks leased for this device during the pull.' }),
    serverTime: timestamp,
  }),
);

export const operationResultSchema = registry.register(
  'SyncOperationResult',
  z.object({
    opId: uuid,
    type: syncOperationTypeSchema,
    status: z.enum(['applied', 'replayed', 'rejected']),
    id: uuid.optional(),
    serverSeq: z.number().int().optional(),
    warnings: z.array(warningSchema).optional(),
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string(),
        details: z.record(z.unknown()).optional(),
      })
      .optional(),
    retryable: z.boolean().optional().openapi({
      description:
        'On `rejected`: true means retry later unchanged; false means the operation can never succeed as sent.',
    }),
  }),
);

export const pushResultSchema = registry.register(
  'SyncPushResult',
  z.object({ results: z.array(operationResultSchema), serverTime: timestamp }),
);

export const syncStateSchema = registry.register(
  'SyncState',
  z.object({
    deviceId: uuid,
    lastPullSeq: z.number().int(),
    lastPullAt: timestamp.nullable(),
    lastPushAt: timestamp.nullable(),
    fullResyncRequired: z.boolean(),
    serverTime: timestamp,
    entities: z.array(
      z.object({
        entity: syncEntitySchema,
        keyColumns: z.array(z.string()),
        softDelete: z.boolean(),
        pushedBy: z.array(syncOperationTypeSchema),
      }),
    ),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/sync/changes',
  tags: ['Sync'],
  summary: 'Pull changes after a sequence number',
  description:
    'One tenant-wide cursor covers every entity. Page while `hasMore` is true; apply a page in one local transaction and only then advance `since`. A device flagged for resync answers 409 `SYNC_RESET_REQUIRED` unless `since=0`.',
  security: accessTokenSecurity,
  request: { query: pullQuery },
  responses: {
    200: jsonResponse('Changes.', dataEnvelope(pullResultSchema)),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/sync/push',
  tags: ['Sync'],
  summary: 'Push queued offline operations',
  description:
    'Each operation is validated and applied independently, in order, through the same code path as its REST endpoint. The response is always 200 with a per-operation status; retry only operations marked `retryable`. Do not send an Idempotency-Key — the `opId` and the entity ids are the idempotency keys.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: pushBody } } } },
  responses: {
    200: jsonResponse('Per-operation results.', dataEnvelope(pushResultSchema)),
    ...errorResponses(413),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/sync/state',
  tags: ['Sync'],
  summary: 'This device’s sync cursor and the entity catalogue',
  security: accessTokenSecurity,
  responses: { 200: jsonResponse('State.', dataEnvelope(syncStateSchema)), ...errorResponses() },
});
