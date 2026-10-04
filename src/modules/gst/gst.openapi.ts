import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  calendarDate,
  dataEnvelope,
  jsonResponse,
  pageEnvelope,
  paise,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  acceptMatchBody,
  createGstr2bImportBody,
  createPeriodBody,
  filePeriodBody,
  ITC_CATEGORIES,
  ITC_STATES,
  itcRegisterQuery,
  listMatchesQuery,
  listPeriodsQuery,
  MATCH_TYPES,
  RETURN_STATUSES,
  RETURN_TYPES,
} from './gst.schemas.js';

const returnPeriod = registry.register(
  'GstReturnPeriod',
  z.object({
    id: uuid,
    gstin: z.string(),
    returnType: z.enum(RETURN_TYPES),
    periodYear: z.number().int(),
    periodMonth: z.number().int(),
    periodFrom: calendarDate,
    periodTo: calendarDate,
    status: z.enum(RETURN_STATUSES),
    workings: z.record(z.unknown()).nullable().openapi({
      description:
        'The computed return, snapshotted when prepared. Never recomputed on read: a void raised in November must not restate October’s filed figures.',
    }),
    totalTaxable: paise.nullable(),
    totalTax: paise.nullable(),
    preparedAt: timestamp.nullable(),
    preparedBy: uuid.nullable(),
    filedAt: timestamp.nullable(),
    filedBy: uuid.nullable(),
    arn: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: timestamp,
  }),
);

const itcEntry = registry.register(
  'ItcRegisterEntry',
  z.object({
    id: uuid,
    gstin: z.string(),
    sourceType: z.enum(['purchase_bill', 'debit_note']),
    sourceId: uuid,
    supplierId: uuid.nullable(),
    supplierGstin: z.string().nullable(),
    supplierName: z.string().nullable(),
    documentDate: calendarDate,
    itcCategory: z.enum(ITC_CATEGORIES),
    ineligibleReason: z.string().nullable(),
    isReverseCharge: z.boolean(),
    cgst: paise,
    sgst: paise,
    igst: paise,
    cess: paise,
    taxableAmount: paise,
    state: z.enum(ITC_STATES),
    claimedPeriod: z.string().nullable(),
    matched2bId: uuid.nullable().openapi({
      description:
        'The GSTR-2B row that supports this credit. Null is the interesting case: credit the shop has paid for and no supplier has reported.',
    }),
    createdAt: timestamp,
  }),
);

const importProgress = registry.register(
  'Gstr2bImport',
  z.object({
    id: uuid,
    gstin: z.string(),
    periodYear: z.number().int(),
    periodMonth: z.number().int(),
    format: z.enum(['json', 'xlsx']),
    status: z.enum([
      'pending',
      'ingesting',
      'ingested',
      'reconciling',
      'reconciled',
      'failed',
      'cancelled',
    ]),
    invoiceCount: z.number().int(),
    exactCount: z.number().int(),
    probableCount: z.number().int(),
    missingInBooks: z.number().int().openapi({
      description: 'Filed by a supplier, absent from the shop’s books — usually a bill nobody entered.',
    }),
    missingIn2b: z.number().int().openapi({
      description:
        'In the books, not filed by any supplier. This is input tax the shop has paid and cannot reclaim until the supplier files.',
    }),
    mismatchCount: z.number().int(),
    errorSummary: z.record(z.unknown()).nullable(),
    ingestedAt: timestamp.nullable(),
    reconciledAt: timestamp.nullable(),
    done: z.boolean(),
  }),
);

const match = registry.register(
  'Gstr2bMatch',
  z.object({
    id: uuid,
    matchType: z.enum(MATCH_TYPES),
    gstr2bInvoiceId: uuid.nullable(),
    purchaseBillId: uuid.nullable(),
    differences: z.record(z.unknown()).nullable(),
    taxDifference: paise.openapi({
      description: 'Signed. Positive means the portal shows more tax than the books do.',
    }),
    acceptedAt: timestamp.nullable(),
    acceptedBy: uuid.nullable(),
    note: z.string().nullable(),
    portalInvoiceNo: z.string().nullable(),
    portalInvoiceDate: calendarDate.nullable(),
    portalSupplierGstin: z.string().nullable(),
    portalSupplierName: z.string().nullable(),
    bookInvoiceNo: z.string().nullable(),
    bookInvoiceDate: calendarDate.nullable(),
    bookDocumentNumber: z.string().nullable(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/gst/periods',
  tags: ['GST'],
  summary: 'Return periods',
  security: accessTokenSecurity,
  request: { query: listPeriodsQuery },
  responses: {
    200: jsonResponse('Newest first.', pageEnvelope(returnPeriod)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/gst/periods',
  tags: ['GST'],
  summary: 'Open a return period',
  description: [
    'Opens a period for working on. Computes nothing — `prepare` does that.',
    '',
    'Returns are per **GSTIN**, not per business: a shop trading in two states holds a',
    'registration per state and files separately for each. Omit `gstin` and the business’s own',
    'is used; a business with more than one must name which.',
    '',
    'A composition dealer files CMP-08 and a regular dealer GSTR-1 and GSTR-3B. Asking for the',
    'wrong one is refused rather than accepted, because filing a return you do not owe tends to',
    'come with the one you do left unfiled.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createPeriodBody } } } },
  responses: {
    201: jsonResponse('Opened.', dataEnvelope(returnPeriod)),
    200: jsonResponse('Already open; the stored period is returned.', dataEnvelope(returnPeriod)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/periods/{id}',
  tags: ['GST'],
  summary: 'One return period',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 200: jsonResponse('Period.', dataEnvelope(returnPeriod)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/gst/periods/{id}/prepare',
  tags: ['GST'],
  summary: 'Compute the return',
  description: [
    'Computes the workings and stores them. Re-runnable as often as the shop likes while the',
    'period is open or prepared — entering a missing bill and preparing again is the normal',
    'workflow, not an error.',
    '',
    'Refused once filed. A filed return is a declaration to the department; a correction belongs',
    'in a later period as an amendment, not as a silent change to what was filed.',
    '',
    'For GSTR-1 the workings carry the itemised tables (B2B, B2CL, exports, SEZ, CDNR, CDNUR),',
    'the B2CS rate-wise aggregate, the nil/exempt/non-GST totals, the HSN summary and the',
    'documents-issued table. GSTR-3B carries the 3.1 sections, the self-assessed reverse-charge',
    'liability, and input tax credit split the four ways table 4 requires.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Prepared.', dataEnvelope(returnPeriod)),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/gst/periods/{id}/file',
  tags: ['GST'],
  summary: 'Record a return as filed',
  description: [
    'Records who declared the return and when, and stores the portal’s acknowledgement number.',
    '',
    '**Nothing here files anything on the shop’s behalf.** The figures are the shop’s own',
    'declaration, so this step is always an explicit action by a person: it requires',
    '`confirm: true`, refuses a period that has not been prepared and reviewed, and cannot be',
    'undone.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: filePeriodBody } } },
  },
  responses: {
    200: jsonResponse('Filed.', dataEnvelope(returnPeriod)),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/periods/{id}/export',
  tags: ['GST'],
  summary: 'Download a prepared return',
  description: [
    'A workbook with one sheet per table (B2B, B2CL, B2CS, exports, SEZ, CDNR, CDNUR,',
    'nil/exempt/non-GST, HSN, documents issued), or the same figures as JSON.',
    '',
    'Reads the snapshotted workings, never recomputing — which is the point of snapshotting them:',
    'the file an accountant was given last week and the figures on screen today have to be the',
    'same thing, or nobody can tell which was filed.',
    '',
    'The JSON carries the workings as stored under an identifying header. It is deliberately not',
    'reshaped into the portal’s abbreviated upload keys: that mapping belongs with a filing',
    'integration that can be tested against the real API, and inventing it here would produce a',
    'file that looks official and may not upload.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    query: z.object({ format: z.enum(['xlsx', 'json']).optional() }),
  },
  responses: {
    200: jsonResponse(
      'A short-lived download URL.',
      dataEnvelope(
        z.object({
          objectKey: z.string(),
          filename: z.string(),
          contentType: z.string(),
          downloadUrl: z.string(),
          expiresAt: timestamp,
        }),
      ),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/itc-register',
  tags: ['GST'],
  summary: 'Input tax credit register',
  description: [
    'One row per inward tax event: a purchase bill claims credit, a debit note reverses part of',
    'it. Amounts are signed, so the register sums to the claimable figure.',
    '',
    'A row is never deleted. A credit that was claimed and then reversed is part of what an',
    'assessment is defended with, so the state moves instead: `available` → `claimed` once a',
    'GSTR-2B row supports it, `reversed` if the document is voided, `ineligible` for a section',
    '17(5) blocked credit.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { query: itcRegisterQuery },
  responses: {
    200: jsonResponse('Newest first.', pageEnvelope(itcEntry)),
    ...errorResponses(),
  },
});

// --- GSTR-2B ---------------------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/v1/gst/2b-imports',
  tags: ['GST'],
  summary: 'GSTR-2B reconciliations',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Newest first.', pageEnvelope(importProgress)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/gst/2b-imports',
  tags: ['GST'],
  summary: 'Register a GSTR-2B statement',
  description: [
    'Returns a signed URL; PUT the statement’s bytes straight to it, as with the catalogue',
    'importer — the file never passes through this API. Then call `ingest`, then `reconcile`.',
    '',
    'The portal ships the statement as JSON, which is the default. A spreadsheet download is',
    'accepted too, since that is what some accountants hand over.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createGstr2bImportBody } } } },
  responses: {
    201: jsonResponse(
      'Registered, with the URL to upload to.',
      dataEnvelope(
        importProgress.extend({
          objectKey: z.string(),
          uploadUrl: z.string(),
          expiresAt: timestamp,
        }),
      ),
    ),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/2b-imports/{id}',
  tags: ['GST'],
  summary: 'Reconciliation progress',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse(
      'Progress, with the credit at risk.',
      dataEnvelope(importProgress.extend({ creditAtRisk: paise })),
    ),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/gst/2b-imports/{id}/ingest',
  tags: ['GST'],
  summary: 'Read the uploaded statement',
  description:
    'Parses the statement and stores its rows as received — deliberately not folded into the purchase register, since the whole value of the feature is the difference between the two. Rows that cannot be read are reported in `errorSummary` rather than dropped: a row nobody could identify is not the same as a supplier who never filed.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse('Ingested.', dataEnvelope(importProgress)),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/gst/2b-imports/{id}/reconcile',
  tags: ['GST'],
  summary: 'Match the statement against the purchase register',
  description: [
    'Three passes, narrowing in confidence. Same GSTIN and invoice number with amounts agreeing',
    'is `exact`; the same document with a figure that disagrees is `mismatch`; the same supplier',
    'and amount with a different number is `probable`, which needs a human to confirm.',
    '',
    'What is left over is the point of the exercise. `missing_in_2b` is a bill in the books that',
    'no supplier reported — input tax the shop has already paid and cannot reclaim until they',
    'file. `creditAtRisk` is that total.',
    '',
    'Bills from unregistered suppliers are skipped rather than reported missing: such a supplier',
    'files nothing, so its absence is correct and listing it would bury the real gaps. The',
    'comparison window is a month either side of the period, because a bill dated in March can',
    'appear in a supplier’s April filing.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: {
    200: jsonResponse(
      'Reconciled.',
      dataEnvelope(z.object({ progress: importProgress, creditAtRisk: paise })),
    ),
    ...errorResponses(409),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/2b-imports/{id}/matches',
  tags: ['GST'],
  summary: 'What reconciliation concluded',
  description:
    'Filter by `matchType` to review one bucket. `missing_in_2b` is the one to act on; `missing_in_books` is usually a bill nobody entered.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }), query: listMatchesQuery },
  responses: { 200: jsonResponse('Matches.', pageEnvelope(match)), ...errorResponses() },
});

registry.registerPath({
  method: 'post',
  path: '/v1/gst/2b-imports/{id}/matches/{matchId}/accept',
  tags: ['GST'],
  summary: 'Confirm a probable match',
  description:
    'Always a human decision, and recorded as one. A probable match is two documents that look alike but are numbered differently; accepting one wrongly claims credit against somebody else’s invoice, which is the error this feature exists to prevent. Once accepted, a later reconciliation leaves it alone.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid, matchId: uuid }),
    body: { content: { 'application/json': { schema: acceptMatchBody } } },
  },
  responses: { 200: jsonResponse('Confirmed.', dataEnvelope(match)), ...errorResponses(422) },
});
