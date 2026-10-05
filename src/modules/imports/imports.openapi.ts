import { z } from 'zod';
import { ITEM_COLUMNS } from '../../domain/import/item-columns.js';
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
  analyseBody,
  createImportBody,
  listImportsQuery,
  listRowsQuery,
} from './imports.schemas.js';

const importProgress = registry.register(
  'ImportProgress',
  z.object({
    id: uuid,
    status: z.enum([
      'pending',
      'ingesting',
      'ingested',
      'analysing',
      'analysed',
      'applying',
      'applied',
      'failed',
      'cancelled',
      'expired',
    ]),
    totalRows: z.number().int(),
    ingestedRows: z.number().int(),
    analysedUpToRow: z.number().int(),
    appliedUpToRow: z.number().int(),
    createCount: z.number().int(),
    updateCount: z.number().int(),
    skipCount: z.number().int(),
    errorCount: z.number().int(),
    columnMap: z.record(z.string(), z.number().int()).nullable().openapi({
      description: 'Field key to the zero-based spreadsheet column it was found in.',
    }),
    done: z.boolean().openapi({
      description: 'False while the current phase should be called again.',
    }),
  }),
);

const importRow = registry.register(
  'ImportRow',
  z.object({
    id: uuid,
    rowNo: z.number().int().openapi({ description: "The spreadsheet's own row number." }),
    action: z.enum(['pending', 'create', 'update', 'skip', 'error']),
    appliedAt: timestamp.nullable(),
    targetId: uuid.nullable(),
    matchRule: z.enum(['code', 'barcode', 'name']).nullable().openapi({
      description: 'Which rule matched an existing item, so the review can explain an update.',
    }),
    raw: z.array(z.string()).openapi({ description: 'The row as read from the file.' }),
    parsed: z.record(z.string(), z.unknown()).nullable(),
    diff: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })).nullable(),
    errors: z.record(z.string(), z.string()).nullable(),
  }),
);

const LIFECYCLE = [
  'Importing is three resumable phases, each advancing a cursor on the job:',
  '',
  '1. `POST /v1/imports` — returns a signed `uploadUrl`; PUT the spreadsheet straight to it.',
  '2. `POST /v1/imports/{id}/ingest` — reads the file once and stores every row.',
  '3. `POST /v1/imports/{id}/analyse` — repeat **until `done` is true**; validates and diffs a chunk per call.',
  '4. Review with `GET /v1/imports/{id}/rows?action=update`.',
  '5. `POST /v1/imports/{id}/apply` — repeat **until `done` is true**; writes a chunk per transaction.',
  '',
  'Every chunk call returns the same progress object, so a client can drive a real progress bar',
  'and resume after being backgrounded. Chunk calls are idempotent on their cursor: a retry after',
  'a dropped response repeats no work.',
].join('\n');

registry.registerPath({
  method: 'post',
  path: '/v1/imports',
  tags: ['Imports'],
  summary: 'Start an import and get an upload URL',
  description: LIFECYCLE,
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createImportBody } } } },
  responses: {
    201: jsonResponse(
      'Upload the file to `uploadUrl`, then call ingest.',
      dataEnvelope(
        z.object({
          id: uuid,
          kind: z.string(),
          objectKey: z.string(),
          uploadUrl: z.string().url(),
          expiresAt: timestamp,
        }),
      ),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/imports/{id}/ingest',
  tags: ['Imports'],
  summary: 'Read the uploaded file',
  description: [
    'Streams the spreadsheet once and stores every row raw, then guesses the column mapping from',
    'the header row. Recognised headers include the exported names and common alternatives —',
    `for example ${ITEM_COLUMNS[0]?.header} also matches "Particulars" and "Product".`,
    '',
    'Fails with `IMPORT_COLUMN_UNMAPPED` if no column maps to a required field, and',
    '`IMPORT_TOO_LARGE` beyond the configured row limit.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Rows stored.', dataEnvelope(importProgress)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/imports/{id}/analyse',
  tags: ['Imports'],
  summary: 'Validate and diff the next chunk',
  description:
    'Call repeatedly until `done` is true. Passing an explicit `columnMap` replaces the guess and restarts analysis from the first row.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: analyseBody } } },
  },
  responses: {
    200: jsonResponse('Progress after this chunk.', dataEnvelope(importProgress)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/imports/{id}/apply',
  tags: ['Imports'],
  summary: 'Write the next chunk',
  description: [
    'Call repeatedly until `done` is true. Each chunk commits on its own, so an interrupted apply',
    'leaves the job in `applying` with `appliedUpToRow` set and can simply be called again — every',
    'row is written at most once.',
    '',
    'Answers `IMPORT_STALE` if the catalogue changed since the review, in which case re-run analyse.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Progress after this chunk.', dataEnvelope(importProgress)),
    409: jsonResponse('The catalogue moved since the review.', z.object({})),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/imports',
  tags: ['Imports'],
  summary: 'Recent imports',
  description: 'Includes jobs left unfinished, so the client can offer to resume or cancel one.',
  security: accessTokenSecurity,
  request: { query: listImportsQuery },
  responses: {
    200: jsonResponse('Newest first.', pageEnvelope(importProgress)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/imports/{id}',
  tags: ['Imports'],
  summary: 'One import',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Progress.', dataEnvelope(importProgress)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/imports/{id}/rows',
  tags: ['Imports'],
  summary: 'The reviewable diff',
  description:
    'Filter with `?action=update` to show what will change, or `?action=error` to show what will not import.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }), query: listRowsQuery },
  responses: {
    200: jsonResponse('Rows in file order.', pageEnvelope(importRow)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/imports/{id}/cancel',
  tags: ['Imports'],
  summary: 'Abandon an import',
  description:
    'Discards the stored rows and purges the upload. Refused once any row has been applied, because this performs no undo.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: noContent('Abandoned.'), ...errorResponses() },
});
