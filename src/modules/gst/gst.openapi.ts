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
  preparePeriodBody,
  RETURN_STATUSES,
  RETURN_TYPES,
} from './gst.schemas.js';
import { importLedgerBody, listLedgerImportsQuery } from './ledgers/ledger.schemas.js';
import { hsnSalesQuery, sacQuery, transactionReportQuery } from './reports/gst-reports.schemas.js';

const gstRegistration = z.object({
  id: uuid,
  gstin: z.string(),
  stateCode: z.string(),
  isPrincipal: z.boolean(),
  status: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  roundOffEnabled: z.boolean(),
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/registrations',
  tags: ['GST'],
  summary: "The business's GST registrations",
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Registrations.', dataEnvelope(z.array(gstRegistration))),
    ...errorResponses(401, 403),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/gst/registrations/{id}',
  tags: ['GST'],
  summary: "Change a registration's settings",
  description: 'Rounding the bill to the rupee is set per registration and is on by default.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: {
      content: { 'application/json': { schema: z.object({ roundOffEnabled: z.boolean() }) } },
    },
  },
  responses: {
    200: jsonResponse('The registration.', dataEnvelope(gstRegistration)),
    ...errorResponses(400, 401, 403, 404),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/rule-sets',
  tags: ['GST'],
  summary: 'Published GST rule sets',
  description:
    'Dated, complete snapshots of the GST rules, including withdrawn ones so a device can drop them. Pass `since` (the latest `changedAt` held) to fetch only what changed. A device selects by date: latest effectiveFrom on or before it, then highest revision.',
  security: accessTokenSecurity,
  request: { query: z.object({ since: z.string().datetime({ offset: true }).optional() }) },
  responses: {
    200: jsonResponse('Rule set versions.', dataEnvelope(z.array(z.record(z.unknown())))),
    ...errorResponses(401),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/hsn-master',
  tags: ['GST'],
  summary: 'The HSN/SAC master',
  description:
    'Codes and descriptions only: rates come from the rule set. `codes` is empty when `version` is what the device already holds. Each code is [code, kind, description, parentCode].',
  security: accessTokenSecurity,
  request: { query: z.object({ version: z.string().max(64).optional() }) },
  responses: {
    200: jsonResponse(
      'The master, or just its version.',
      dataEnvelope(
        z.object({
          version: z.string().nullable(),
          codes: z.array(z.array(z.string().nullable())),
        }),
      ),
    ),
    ...errorResponses(401),
  },
});

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
      description:
        'Filed by a supplier, absent from the shop’s books — usually a bill nobody entered.',
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
  path: '/v1/gst/reports/transactions',
  tags: ['GST'],
  summary: 'GSTR transaction report (Excel)',
  description: [
    'GSTR-1 sales, GSTR-1 credit/debit notes, and the purchase register in the layout of the',
    'official GSTR-2 offline template, for one month and registration.',
    '',
    'Worked out live from current documents with the same engines as the prepared returns; it is',
    'not snapshotted. GSTR-2 has been suspended since 2017, so the purchase files are registers',
    'for reconciliation, not filings, and there is no portal JSON for them.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { query: transactionReportQuery },
  responses: {
    200: jsonResponse(
      'A signed download link.',
      dataEnvelope(
        z.object({
          filename: z.string(),
          downloadUrl: z.string(),
          expiresAt: timestamp,
          rows: z.number().int(),
          issues: z.array(z.record(z.unknown())),
        }),
      ),
    ),
    ...errorResponses(400, 401, 403, 422),
  },
});

const tableReportResponses = {
  200: jsonResponse(
    'With format=json: the tables, in the shape a prepared return is read in. With xlsx or ca: a signed download link.',
    dataEnvelope(z.record(z.unknown())),
  ),
  ...errorResponses(400, 401, 403, 422),
};

registry.registerPath({
  method: 'get',
  path: '/v1/gst/reports/hsn-sales',
  tags: ['GST'],
  summary: 'Sales summary by HSN',
  description:
    'Issued invoices and notes of one registration between two dates, by HSN code, unit and rate, net of credit notes, split into registered-buyer and other as in GSTR-1 Table 12. Uses the same accumulation as Table 12, so the figures agree.',
  security: accessTokenSecurity,
  request: { query: hsnSalesQuery },
  responses: tableReportResponses,
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/reports/sac',
  tags: ['GST'],
  summary: 'SAC (services) report',
  description:
    'Service lines (chapter 99 or listed as services in the HSN/SAC master) by SAC, transaction type and rate, for sales, sale returns, purchases and purchase returns. There is no separate SAC return: services are reported in the HSN tables of GSTR-1 and GSTR-9, so this is an analysis view.',
  security: accessTokenSecurity,
  request: { query: sacQuery },
  responses: tableReportResponses,
});

const ledgerImport = registry.register(
  'GstLedgerImport',
  z.object({
    id: uuid,
    gstin: z.string(),
    kind: z.enum(['cash', 'liability', 'itc_reversal']),
    periodFrom: calendarDate,
    periodTo: calendarDate,
    parserId: z.string(),
    entryCount: z.number().int(),
    newEntryCount: z.number().int().openapi({
      description: 'Entries not already held from an earlier, overlapping file.',
    }),
    issues: z.array(z.record(z.unknown())),
    createdAt: timestamp,
  }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/gst/ledger-imports',
  tags: ['GST'],
  summary: 'Import a GSTN ledger file',
  description: [
    'Takes a ledger exactly as the GST portal produced it (cash ledger, return-liability ledger, or',
    'credit reversal and re-claim ledger) and keeps its entries.',
    '',
    'The file is checked against the official schema and refused when it is not that ledger, is for',
    'another GSTIN, or has a window that cannot be read. The same document is accepted once; an entry',
    'that arrives again in an overlapping file is kept once.',
    '',
    'Credit reclaimed (6H) and reversed come from the credit reversal ledger. Tax paid through cash or',
    'credit is read by a rule set that is empty until it has been checked against real ledger files,',
    'so GSTR-9 shows tax paid as unknown rather than guessing.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: importLedgerBody } } } },
  responses: {
    201: jsonResponse('Imported (or already imported).', dataEnvelope(ledgerImport)),
    ...errorResponses(400, 401, 403, 422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/gst/ledger-imports',
  tags: ['GST'],
  summary: 'Imported ledger files',
  security: accessTokenSecurity,
  request: { query: listLedgerImportsQuery },
  responses: {
    200: jsonResponse('Newest first.', dataEnvelope(z.array(ledgerImport))),
    ...errorResponses(401, 403),
  },
});

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
    '',
    "GSTR-9 is summed from the financial year's period returns (filed, else prepared, else worked",
    'out from the books and flagged) and reconciled against the books. The optional body field',
    '`considerNonTaxAsExempt` reports non-GST outward supplies as exempted (5D) instead of 5F.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { required: false, content: { 'application/json': { schema: preparePeriodBody } } },
  },
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
    'format=xlsx: a workbook with one sheet per table (GSTR-1: b2b, b2cl, b2cs, cdnr, cdnur, exp,',
    'nil/exempt/non-GST, HSN b2b/b2c, documents issued; GSTR-3B: 3.1, 3.2, 4, 5), rendered from the',
    'same sheets the app shows. format=ca adds a summary, the issues list and (GSTR-3B) the ITC register.',
    '',
    'format=json: portal upload JSON from a versioned mapper, validated against the official schema.',
    'GSTR-3B uses the official Save schema (portal ready). GSTR-1 follows the official Get response',
    'schemas only (no official upload schema was available), so it is always labelled draft, and the',
    'sections with no official schema (exports, advances, nil/exempt, HSN, documents issued,',
    'amendments) are refused unless acceptUnsupported=true, which produces a clearly named partial draft.',
    'The response says which mapper and schema fingerprint produced the file and lists every issue.',
    '',
    'Reads the snapshotted workings, never recomputing, so the file an accountant was given last week',
    'and the figures on screen today are the same thing.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    query: z.object({
      format: z.enum(['xlsx', 'json', 'ca']).optional(),
      acceptUnsupported: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: jsonResponse(
      'A short-lived download URL.',
      dataEnvelope(
        z.object({
          objectKey: z.string(),
          filename: z.string(),
          contentType: z.string(),
          payloadStatus: z.enum(['portal_ready', 'draft', 'draft_partial']).optional(),
          mapperId: z.string().optional(),
          schemaSha256: z.string().optional(),
          issues: z
            .array(
              z.object({
                severity: z.string(),
                code: z.string(),
                message: z.string(),
                path: z.string().optional(),
              }),
            )
            .optional(),
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
