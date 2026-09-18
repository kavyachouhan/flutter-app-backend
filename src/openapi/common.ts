/**
 * Components shared by every module: the error envelope, the enums clients
 * branch on, and the standard error responses. Registered by name so they
 * appear once under `components/schemas` and generated clients get real
 * enums instead of inline string unions.
 */
import { z } from 'zod';
import { ErrorCode, WarningCode } from '../lib/errors.js';
import { PERMISSIONS, ROLES } from '../modules/auth/permissions.js';
import { FEATURES } from '../modules/entitlements/entitlements.js';
import { TENDER_MODES } from '../modules/invoices/invoices.schemas.js';
import { DOCUMENT_TYPES } from '../modules/numbering/numbering.schemas.js';
import { REASON_CODES } from '../modules/stock/stock.schemas.js';
import { jsonResponse, registry } from './registry.js';

const codes = Object.values(ErrorCode) as [string, ...string[]];
const warningCodes = Object.values(WarningCode) as [string, ...string[]];

export const errorCodeSchema = registry.register(
  'ErrorCode',
  z.enum(codes).openapi({
    description:
      'Stable machine-readable failure code. Additive only: new codes appear over time, so clients must tolerate unknown values.',
  }),
);

export const warningCodeSchema = registry.register(
  'WarningCode',
  z.enum(warningCodes).openapi({
    description: 'A condition noted on a successful write that did not reject it.',
  }),
);

export const roleSchema = registry.register('Role', z.enum(ROLES));
export const permissionSchema = registry.register('Permission', z.enum(PERMISSIONS));
export const featureSchema = registry.register('Feature', z.enum(FEATURES));
export const tenderModeSchema = registry.register('TenderMode', z.enum(TENDER_MODES));
export const documentTypeSchema = registry.register('DocumentType', z.enum(DOCUMENT_TYPES));
export const stockReasonCodeSchema = registry.register('StockReasonCode', z.enum(REASON_CODES));
export const taxModeSchema = registry.register(
  'TaxMode',
  z.enum(['gst', 'non_gst', 'composition']),
);
export const supplyTypeSchema = registry.register(
  'SupplyType',
  z.enum(['intra_state', 'inter_state']),
);
export const documentStatusSchema = registry.register('DocumentStatus', z.enum(['issued', 'void']));
export const platformSchema = registry.register(
  'Platform',
  z.enum(['android', 'ios', 'windows', 'macos', 'web']),
);

export const warningSchema = registry.register(
  'Warning',
  z.object({ code: warningCodeSchema, details: z.record(z.unknown()) }),
);

export const errorResponseSchema = registry.register(
  'ErrorResponse',
  z.object({
    error: z.object({
      code: errorCodeSchema,
      message: z
        .string()
        .openapi({ description: 'Human-readable; may be reworded or translated.' }),
      details: z
        .record(z.unknown())
        .optional()
        .openapi({ description: 'Structured, client-safe context (e.g. `fields` on validation).' }),
      requestId: z
        .string()
        .optional()
        .openapi({ description: 'Echo of X-Request-Id, for support.' }),
    }),
  }),
);

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed or the request is malformed. `details.fields` names each problem.',
  401: 'Missing, expired or invalid token.',
  402: 'The plan does not include this feature, or a quota is exhausted.',
  403: 'The role lacks the permission, or the outlet is not permitted.',
  404: 'Not found, including resources owned by another tenant.',
  409: 'Conflicts with current state (duplicate, immutable document, stale write).',
  413: 'Body exceeds the size limit.',
  422: 'Structurally valid but cannot be processed (see the error code).',
  429: 'Rate limited; honour `Retry-After` and `retryAfterSeconds`.',
  503: 'A dependency is unavailable; retry shortly.',
};

/** The error responses every authenticated route can return, plus any extra codes. */
export function errorResponses(...extra: number[]) {
  const statuses = new Set([400, 401, 403, 404, 429, 503, ...extra]);
  const out: Record<string, ReturnType<typeof jsonResponse>> = {};
  for (const status of [...statuses].sort((a, b) => a - b)) {
    out[String(status)] = jsonResponse(ERROR_DESCRIPTIONS[status] ?? 'Error.', errorResponseSchema);
  }
  return out;
}
