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
    kind: z.enum(['items', 'customers', 'suppliers', 'opening_stock']),
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
    headers: z.array(z.string()).openapi({ description: "The file's own header row." }),
    mappingSource: z.enum(['auto', 'saved', 'confirmed']).nullable().openapi({
      description:
        'auto: guessed from the headers. saved: the shop confirmed this exact header layout before, so the matching screen can be skipped. confirmed: confirmed for this file.',
    }),
    missingRequired: z.array(z.string()).openapi({
      description:
        'Required fields the matching does not cover. Analyse refuses until this is empty.',
    }),
    fields: z
      .array(
        z.object({
          key: z.string(),
          label: z.string(),
          required: z.boolean(),
          type: z.string(),
          createOnly: z.boolean().openapi({
            description:
              'Applied only when the import creates a record (opening stock, opening balance).',
          }),
        }),
      )
      .openapi({ description: 'Every field this kind can import, for the matching screen.' }),
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
    matchRule: z.enum(['code', 'barcode', 'name', 'phone', 'gstin']).nullable().openapi({
      description: 'Which rule matched an existing record, so the review can explain an update.',
    }),
    raw: z.array(z.string()).openapi({ description: 'The row as read from the file.' }),
    parsed: z.record(z.string(), z.unknown()).nullable(),
    diff: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })).nullable(),
    errors: z.record(z.string(), z.string()).nullable(),
    notes: z.array(z.string()).nullable().openapi({
      description:
        'Worth knowing but not stopping the row, e.g. a rupee discount converted to a %.',
    }),
  }),
);

const LIFECYCLE = [
  'Importing is three resumable phases, each advancing a cursor on the job:',
  '',
  '1. `POST /v1/imports` — returns a signed `uploadUrl`; PUT the spreadsheet straight to it.',
  '2. `POST /v1/imports/{id}/ingest` — safety-checks and reads the file once, stores every row, and',
  '   proposes a column matching (the saved one, when this header layout was confirmed before).',
  '   When `mappingSource` is `auto`, show the matching screen and send the confirmed `columnMap`',
  '   with the first analyse call.',
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
        importProgress.extend({
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
    'Checks the file before reading it — macros, embedded objects and zip bombs are refused with',
    '`IMPORT_UNSAFE` — then reads it once and stores every row raw. The column matching is the one',
    'the shop confirmed for this exact header layout before, if any, otherwise a guess from the',
    'header row. Recognised headers include the exported names and what other billing apps write —',
    `for example ${ITEM_COLUMNS[0]?.header} also matches "Item Name", "Particulars" and "Product".`,
    '',
    'A file whose matching leaves a required field unmatched is still stored; `missingRequired`',
    'says which, and analyse refuses until a `columnMap` covers them. `IMPORT_TOO_LARGE` beyond the',
    'configured row limit.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse(
      'Rows stored.',
      dataEnvelope(
        importProgress.extend({
          sampleRows: z.array(z.array(z.string())).openapi({
            description: 'The first rows as read, for examples on the matching screen.',
          }),
        }),
      ),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/imports/{id}/analyse',
  tags: ['Imports'],
  summary: 'Validate and diff the next chunk',
  description: [
    'Call repeatedly until `done` is true. Passing an explicit `columnMap` (from the matching screen)',
    'replaces the guess, restarts analysis from the first row and — unless `remember` is false — saves',
    'the matching for the next file with the same headers. Answers `IMPORT_COLUMN_UNMAPPED` while a',
    'required field has no column.',
  ].join('\n'),
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
    'Answers `IMPORT_STALE` if the items, customers or suppliers being imported changed since the',
    'review, in which case re-run analyse.',
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
