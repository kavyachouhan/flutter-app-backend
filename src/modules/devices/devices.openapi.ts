import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { updateDeviceBody } from './devices.schemas.js';

export const deviceSchema = registry.register(
  'Device',
  z.object({
    id: uuid,
    userId: uuid.nullable(),
    userName: z.string().nullable(),
    outletId: uuid.nullable(),
    counterId: uuid.nullable(),
    deviceKey: z.string(),
    label: z.string().nullable(),
    platform: z.string(),
    appVersion: z.string().nullable(),
    osVersion: z.string().nullable(),
    lastSyncSeq: z.number().int(),
    lastSeenAt: timestamp.nullable(),
    isActive: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/devices',
  tags: ['Devices'],
  summary: 'List registered devices',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Devices.', dataEnvelope(z.array(deviceSchema))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/devices/{id}',
  tags: ['Devices'],
  summary: 'Relabel or bind a device to an outlet/counter',
  security: accessTokenSecurity,
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: updateDeviceBody } } },
  },
  responses: { 200: jsonResponse('Updated.', dataEnvelope(deviceSchema)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/devices/{id}/deactivate',
  tags: ['Devices'],
  summary: 'Deactivate a device',
  description: 'Revokes its refresh tokens immediately; it can no longer sync or sign in.',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: { 200: jsonResponse('Deactivated.', dataEnvelope(deviceSchema)), ...errorResponses() },
});
