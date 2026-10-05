import { z } from 'zod';
import { TEMPLATE_KEYS } from '../../domain/print/templates.js';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  noContent,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import {
  createCustomFieldBody,
  listCustomFieldsQuery,
  printPayloadQuery,
  updateCustomFieldBody,
  upsertPrintProfileBody,
  CUSTOM_FIELD_DATA_TYPES,
  CUSTOM_FIELD_DOCUMENT_TYPES,
} from './print.schemas.js';

// --- The print contract ----------------------------------------------------

const printField = registry.register(
  'PrintField',
  z.object({ label: z.string(), value: z.string() }),
);

const printAmountRow = registry.register(
  'PrintAmountRow',
  z.object({
    label: z.string(),
    amount: z.string().openapi({ description: 'Already formatted, e.g. "₹1,234.50".' }),
    emphasis: z.boolean().optional(),
    paise: z
      .number()
      .int()
      .optional()
      .openapi({ description: 'Raw value, so a renderer can skip a zero row without parsing.' }),
  }),
);

export const printDocumentSchema = registry.register(
  'PrintDocument',
  z
    .object({
      kind: z.enum(['invoice', 'credit_note', 'payment_receipt', 'estimate']),
      title: z.string().openapi({ description: '"TAX INVOICE", "BILL OF SUPPLY", "CREDIT NOTE".' }),
      business: z.object({
        name: z.string(),
        addressLines: z.array(z.string()),
        phone: z.string().optional(),
        gstin: z.string().optional(),
        email: z.string().optional(),
        logoObjectKey: z.string().optional().openapi({
          description:
            'Storage key, not a URL. Resolve it with GET /v1/uploads/url; URLs expire and the printer may be offline.',
        }),
        upiId: z.string().optional(),
        bankLines: z.array(z.string()),
      }),
      customer: z
        .object({
          name: z.string(),
          phone: z.string().optional(),
          gstin: z.string().optional(),
          addressLines: z.array(z.string()),
          stateName: z.string().optional(),
        })
        .optional(),
      meta: z.array(printField),
      items: z.array(
        z.object({
          name: z.string(),
          quantity: z.string(),
          rate: z.string(),
          amount: z.string(),
          hsnCode: z.string().optional(),
          unit: z.string().optional(),
          discount: z.string().optional(),
          taxRate: z.string().optional(),
          note: z.string().optional(),
        }),
      ),
      totals: z.array(printAmountRow),
      taxRows: z.array(
        z.object({
          rate: z.string(),
          taxable: z.string(),
          cgst: z.string().optional(),
          sgst: z.string().optional(),
          igst: z.string().optional(),
          cess: z.string().optional(),
        }),
      ),
      tenders: z.array(printAmountRow),
      customFields: z.array(printField),
      amountInWords: z.string().optional(),
      qrPayload: z.string().optional(),
      qrCaption: z.string().optional(),
      footerLines: z.array(z.string()),
      termsLines: z.array(z.string()),
      signatureLabel: z.string().optional(),
      copyLabel: z.string().optional(),
      showHsn: z.boolean(),
      showTaxColumn: z.boolean(),
    })
    .openapi({
      description:
        'A document ready to draw. Every string is pre-formatted and every legal title is decided server-side: the renderer performs no arithmetic, consults no locale and looks nothing up.',
    }),
);

// --- Configuration ---------------------------------------------------------

const printProfileSchema = registry.register(
  'PrintProfile',
  z.object({
    id: uuid,
    outletId: uuid.nullable().openapi({ description: 'Null is the tenant-wide default.' }),
    templateKey: z.enum(TEMPLATE_KEYS),
    showHsn: z.boolean().nullable(),
    showTaxColumn: z.boolean().nullable(),
    showTaxSummary: z.boolean().nullable(),
    showAmountInWords: z.boolean().nullable(),
    showSignature: z.boolean().nullable(),
    logoObjectKey: z.string().nullable(),
    signatureObjectKey: z.string().nullable(),
    signatureLabel: z.string().nullable(),
    upiId: z.string().nullable(),
    bankLines: z.array(z.string()),
    termsLines: z.array(z.string()),
    footerLines: z.array(z.string()),
    lookupBaseUrl: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

const templateSchema = registry.register(
  'PrintTemplate',
  z.object({
    key: z.enum(TEMPLATE_KEYS),
    title: z.string(),
    description: z.string(),
    paper: z.enum(['thermal', 'a4']),
    showHsn: z.boolean(),
    showTaxColumn: z.boolean(),
    showTaxSummary: z.boolean(),
    showAmountInWords: z.boolean(),
    showCustomerBlock: z.boolean(),
    showSignature: z.boolean(),
    copyLabels: z.array(z.string()),
  }),
);

const customFieldSchema = registry.register(
  'CustomFieldDefinition',
  z.object({
    id: uuid,
    key: z.string(),
    label: z.string(),
    dataType: z.enum(CUSTOM_FIELD_DATA_TYPES),
    isRequired: z.boolean(),
    sortOrder: z.number().int(),
    documentTypes: z.array(z.enum(CUSTOM_FIELD_DOCUMENT_TYPES)),
    maxLength: z.number().int().nullable(),
    placeholder: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);

// --- Paths -----------------------------------------------------------------

for (const [path, tag, summary] of [
  ['/v1/invoices/{id}/print-payload', 'Invoices', 'Printable invoice'],
  ['/v1/credit-notes/{id}/print-payload', 'Credit notes', 'Printable credit note'],
  ['/v1/payments/{id}/print-payload', 'Payments', 'Printable receipt'],
] as const) {
  registry.registerPath({
    method: 'get',
    path,
    tags: [tag],
    summary,
    description:
      'Returns the document fully resolved for printing. Note the response is cacheable on the device: the payload for an issued document never changes except for the copy label.',
    security: accessTokenSecurity,
    request: { params: z.object({ id: uuid }), query: printPayloadQuery },
    responses: {
      200: jsonResponse('The document.', dataEnvelope(printDocumentSchema)),
      ...errorResponses(422),
    },
  });
}

registry.registerPath({
  method: 'get',
  path: '/v1/print-profiles',
  tags: ['Print settings'],
  summary: 'Print profiles and the available templates',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse(
      'Profiles, default first.',
      dataEnvelope(
        z.object({
          profiles: z.array(printProfileSchema),
          templates: z.array(templateSchema),
        }),
      ),
    ),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'put',
  path: '/v1/print-profiles/{outletId}',
  tags: ['Print settings'],
  summary: 'Create or replace a print profile',
  description:
    'Pass the literal `default` as outletId for the tenant-wide profile that every outlet inherits from, field by field.',
  security: accessTokenSecurity,
  request: {
    params: z.object({
      outletId: z.string().openapi({ description: 'An outlet id, or `default`.' }),
    }),
    body: { content: { 'application/json': { schema: upsertPrintProfileBody } } },
  },
  responses: {
    200: jsonResponse('Saved.', dataEnvelope(printProfileSchema)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/custom-fields',
  tags: ['Print settings'],
  summary: 'Custom field definitions',
  security: accessTokenSecurity,
  request: { query: listCustomFieldsQuery },
  responses: {
    200: jsonResponse('Definitions in print order.', dataEnvelope(z.array(customFieldSchema))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/custom-fields',
  tags: ['Print settings'],
  summary: 'Define a custom field',
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createCustomFieldBody } } } },
  responses: {
    201: jsonResponse('Created.', dataEnvelope(customFieldSchema)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/custom-fields/{id}',
  tags: ['Print settings'],
  summary: 'Update a custom field',
  description: 'The key cannot change: issued documents already carry it.',
  security: accessTokenSecurity,
  request: {
    params: z.object({ id: uuid }),
    body: { content: { 'application/json': { schema: updateCustomFieldBody } } },
  },
  responses: {
    200: jsonResponse('Updated.', dataEnvelope(customFieldSchema)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/custom-fields/{id}',
  tags: ['Print settings'],
  summary: 'Retire a custom field',
  description:
    'Soft delete. Documents already issued keep printing the field with its label; new documents may no longer carry the key.',
  security: accessTokenSecurity,
  request: { params: z.object({ id: uuid }) },
  responses: { 204: noContent('Retired.'), ...errorResponses() },
});
