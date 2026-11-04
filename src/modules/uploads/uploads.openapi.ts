import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  registry,
  timestamp,
} from '../../openapi/registry.js';
import { downloadUrlQuery, downloadUrlsBody, signUploadBody } from './uploads.schemas.js';

const signedUpload = registry.register(
  'SignedUpload',
  z.object({
    objectKey: z.string().openapi({
      description:
        'Store this on the record that owns the file (print profile, expense, import job). It is the durable identifier; URLs are not.',
    }),
    uploadUrl: z.string().url().openapi({
      description: 'PUT the bytes here directly, with the same Content-Type that was signed.',
    }),
    expiresAt: timestamp,
  }),
);

const signedDownload = registry.register(
  'SignedDownload',
  z.object({ url: z.string().url(), expiresAt: timestamp }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/uploads/sign',
  tags: ['Uploads'],
  summary: 'Get a short-lived URL to upload a file to',
  description: [
    'Files never pass through this API. Sign, then PUT the bytes straight to the returned URL.',
    '',
    'Content type and size are validated here, at signing time, because it is the last point the',
    'server sees the request. Limits per kind: logo 2 MB and signature 1 MB (png/jpeg/webp),',
    'receipt 5 MB (png/jpeg/webp/pdf), item_image and attachment_image 5 MB (png/jpeg/webp),',
    'attachment_file 10 MB (pdf, Office documents, csv, txt, zip, gzip), import 10 MB (xlsx/csv).',
    '`export` objects are written by the server and cannot be signed for upload.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: signUploadBody } } } },
  responses: {
    201: jsonResponse('Upload with this URL before it expires.', dataEnvelope(signedUpload)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/uploads/url',
  tags: ['Uploads'],
  summary: 'Get a short-lived URL to read a file',
  description:
    'Resolves an object key — such as the `logoObjectKey` on a print payload — to a readable URL. A key belonging to another business answers 403.',
  security: accessTokenSecurity,
  request: { query: downloadUrlQuery },
  responses: {
    200: jsonResponse('Read with this URL before it expires.', dataEnvelope(signedDownload)),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/uploads/urls',
  tags: ['Uploads'],
  summary: 'Get read URLs for up to 50 files at once',
  description: [
    'For lists that show a picture per row. A key belonging to another business answers 403 for the',
    'whole call. A key whose file no longer exists comes back with `url: null`.',
  ].join('\n'),
  security: accessTokenSecurity,
  request: { body: { content: { 'application/json': { schema: downloadUrlsBody } } } },
  responses: {
    200: jsonResponse(
      'One entry per distinct key, in order.',
      dataEnvelope(
        z.array(
          z.object({
            key: z.string(),
            url: z.string().url().nullable(),
            expiresAt: timestamp.nullable(),
          }),
        ),
      ),
    ),
    ...errorResponses(),
  },
});
