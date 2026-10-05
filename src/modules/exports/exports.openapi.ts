import { z } from 'zod';
import { LABEL_TEMPLATE_KEYS } from '../../domain/labels/templates.js';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  registry,
  timestamp,
  uuid,
} from '../../openapi/registry.js';
import { createExportBody, labelPayloadBody } from './exports.schemas.js';

const exportResult = registry.register(
  'ExportResult',
  z.object({
    objectKey: z.string(),
    filename: z.string(),
    kind: z.string(),
    rowCount: z.number().int(),
    truncated: z.boolean().openapi({
      description: 'True when the export hit the row cap, so the file is incomplete.',
    }),
    sizeBytes: z.number().int(),
    downloadUrl: z.string().url(),
    expiresAt: timestamp.openapi({
      description: 'After this, re-sign the objectKey with GET /v1/uploads/url.',
    }),
  }),
);

const labelTemplate = registry.register(
  'LabelTemplate',
  z.object({
    key: z.enum(LABEL_TEMPLATE_KEYS),
    title: z.string(),
    description: z.string(),
    media: z.enum(['sheet', 'roll']),
    widthMm: z.number(),
    heightMm: z.number(),
    cols: z.number().int(),
    rows: z.number().int().nullable().openapi({ description: 'Null on a continuous roll.' }),
    gapXMm: z.number(),
    gapYMm: z.number(),
    marginTopMm: z.number(),
    marginLeftMm: z.number(),
    pageWidthMm: z.number().nullable(),
    pageHeightMm: z.number().nullable(),
    maxNameChars: z.number().int(),
    maxNameLines: z.number().int(),
    showBarcodeText: z.boolean(),
    showUnit: z.boolean(),
    labelsPerPage: z.number().int().nullable(),
  }),
);

const labelPayload = registry.register(
  'LabelPayload',
  z.object({
    template: labelTemplate,
    labels: z.array(
      z.object({
        itemId: uuid,
        lines: z.array(z.string()).openapi({
          description: 'The item name, already wrapped and truncated to the label width.',
        }),
        priceText: z.string().nullable().openapi({
          description:
            'Pre-formatted. Carries the "MRP" prefix only when the value really is a declared MRP.',
        }),
        secondaryText: z.string().nullable(),
        barcode: z.object({
          value: z.string(),
          symbology: z.enum(['ean13', 'ean8', 'upca', 'code128']),
          isRetailCode: z.boolean().openapi({
            description: 'False when the value fell back to Code 128 from a retail symbology.',
          }),
        }),
        barcodeText: z.string().nullable(),
        copies: z.number().int(),
      }),
    ),
    errors: z.array(z.object({ itemId: uuid, name: z.string(), reason: z.string() })).openapi({
      description: 'Items that cannot be labelled, named so the user can fix them.',
    }),
    totalLabels: z.number().int(),
    pages: z.number().int().nullable(),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/exports',
  tags: ['Exports'],
  summary: 'Export data as a spreadsheet',
  description: [
    'Generates an .xlsx, stores it, and returns a short-lived `downloadUrl`. Keep the `objectKey`:',
    'the URL expires but the key does not, and `GET /v1/uploads/url` re-signs it.',
    '',
    'The **items** export is round-trippable — its headers are exactly what `POST /v1/imports`',
    'recognises, so export, edit in Excel, and import back is a supported workflow. Opening stock',
    'is deliberately not exported, because re-importing it would re-apply an opening balance.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: createExportBody } } } },
  responses: {
    201: jsonResponse('The generated file.', dataEnvelope(exportResult)),
    ...errorResponses(422),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/labels/templates',
  tags: ['Labels'],
  summary: 'Label stationery sizes',
  description:
    'Physical dimensions in millimetres, as printed on the packet of labels. Where things sit inside a label is the renderer’s decision.',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Available templates.', dataEnvelope(z.array(labelTemplate))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/labels/payload',
  tags: ['Labels'],
  summary: 'Barcode label data, ready to draw',
  description: [
    'Returns formatted strings and a chosen symbology per label; the client renders them. Nothing',
    'here is an image, so the same payload drives an A4 sticker sheet and an ESC/POS label printer.',
    '',
    'Symbology is chosen, not assumed: a numeric value is `ean13`, `upca` or `ean8` only when its',
    'check digit is valid, and otherwise falls back to `code128`. Many shops use 13-digit internal',
    'codes that are not valid EAN, and encoding one as EAN-13 prints a label that scans as a',
    'different product.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: labelPayloadBody } } } },
  responses: {
    200: jsonResponse(
      'Labels and any items that could not be labelled.',
      dataEnvelope(labelPayload),
    ),
    ...errorResponses(422),
  },
});
