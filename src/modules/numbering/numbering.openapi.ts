import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { documentTypeSchema, errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  cancelUnusedBody,
  createSeriesBody,
  leaseBody,
  listSeriesQuery,
} from './numbering.schemas.js';

export const financialYearSchema = registry.register(
  'FinancialYear',
  z.object({
    startYear: z.number().int(),
    label: z.string().openapi({ example: '2026-27' }),
    shortLabel: z.string().openapi({ example: '26-27' }),
    startDate: calendarDate,
    endDate: calendarDate,
  }),
);

export const seriesSchema = registry.register(
  'DocumentSeries',
  z.object({
    id: uuid,
    outletId: uuid,
    counterId: uuid.nullable(),
    documentType: documentTypeSchema,
    fyStartYear: z.number().int(),
    prefix: z.string(),
    includeOutletCode: z.boolean(),
    includeCounterCode: z.boolean(),
    includeFinancialYear: z.boolean(),
    padding: z.number().int(),
    separator: z.string(),
    nextSeq: z.number().int(),
    isActive: z.boolean(),
    outletCode: z.string(),
    counterCode: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    financialYear: financialYearSchema,
    maxSequence: z
      .number()
      .int()
      .openapi({ description: 'Highest sequence this format can print.' }),
    maxLength: z.number().int().openapi({ description: 'GST rule 46(b) length limit in force.' }),
  }),
);

export const numberBlockSchema = registry.register(
  'NumberBlock',
  z.object({
    id: uuid,
    seriesId: uuid,
    deviceId: uuid,
    startSeq: z.number().int(),
    endSeq: z.number().int(),
    consumedUpTo: z.number().int().nullable(),
    expiresAt: timestamp,
  }),
);

export const unusedRangeSchema = registry.register(
  'UnusedNumberRange',
  z.object({
    from: z.number().int(),
    to: z.number().int(),
    count: z.number().int(),
    status: z.enum(['cancellable', 'in_use', 'device_offline']).openapi({
      description:
        'cancellable: nothing can still be issued under these numbers. in_use: a live block is still being billed from. device_offline: the block expired, but its device has not been online since and may hold bills not yet sent.',
    }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/numbering/series',
  tags: ['Numbering'],
  summary: 'List document series',
  security: accessTokenSecurity,
  request: { query: listSeriesQuery },
  responses: {
    200: jsonResponse('Series.', dataEnvelope(z.array(seriesSchema))),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: 'post',
  path: '/v1/numbering/series',
  tags: ['Numbering'],
  summary: 'Create a series',
  description:
    'One series per (outlet, counter, document type, financial year). The format is validated against the highest number it will ever print.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createSeriesBody } } } },
  responses: { 201: jsonResponse('Created.', dataEnvelope(seriesSchema)), ...errorResponses(409) },
});
registry.registerPath({
  method: 'post',
  path: '/v1/numbering/series/{id}/leases',
  tags: ['Numbering'],
  summary: 'Lease a block of numbers for this device',
  description:
    'Blocks never overlap. Issue from the block offline; unused numbers in an expired block become GSTR-1 gaps.',
  security: accessTokenSecurity,
  request: { params: idParams, body: { content: { 'application/json': { schema: leaseBody } } } },
  responses: {
    201: jsonResponse(
      'Leased.',
      dataEnvelope(z.object({ block: numberBlockSchema, series: seriesSchema })),
    ),
    ...errorResponses(422),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/numbering/series/{id}/gaps',
  tags: ['Numbering'],
  summary: 'Unused numbers (GSTR-1 Table 13)',
  security: accessTokenSecurity,
  request: { params: idParams },
  responses: {
    200: jsonResponse('Ranges.', dataEnvelope(z.array(unusedRangeSchema))),
    ...errorResponses(422),
  },
});
registry.registerPath({
  method: 'get',
  path: '/v1/numbering/leases',
  tags: ['Numbering'],
  summary: 'Live blocks held by this device',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Blocks.', dataEnvelope(z.array(numberBlockSchema))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/numbering/unused-numbers/cancel',
  tags: ['Numbering'],
  summary: 'Declare unused reserved numbers cancelled (GSTR-1 Table 13)',
  description:
    'Declares cancelled every unused number nothing can still be issued under, in one series or in every series the caller can see, so Table 13 accounts for it instead of reporting a gap. A number declared cancelled is refused to any later upload. Numbers that must wait are returned with why.',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: cancelUnusedBody } } } },
  responses: {
    200: jsonResponse(
      'Declared.',
      dataEnvelope(
        z.object({
          cancelled: z.number().int(),
          waiting: z.number().int(),
          series: z.array(
            z.object({
              seriesId: uuid,
              cancelled: z.array(unusedRangeSchema),
              waiting: z.array(unusedRangeSchema),
            }),
          ),
        }),
      ),
    ),
    ...errorResponses(404),
  },
});
