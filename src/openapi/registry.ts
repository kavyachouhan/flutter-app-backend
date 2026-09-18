/**
 * The OpenAPI registry every module registers its paths into.
 *
 * Request schemas are the same Zod objects the `validate()` middleware runs,
 * so the document cannot describe a body the server would reject. Response
 * schemas are declared next to each module in `<module>.openapi.ts`; they are
 * the contract the Flutter and React clients generate models from, so a
 * field added to a repository row must be added here too (the sample
 * round-trip tests in the client catch an omission).
 *
 * Import this module before calling `.openapi()` on any schema: it patches
 * Zod once, for the whole process.
 */
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
  type ResponseConfig,
} from '@asteasolutions/zod-to-openapi';
import { z, type ZodTypeAny } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

/** Bearer access token issued by POST /auth/sessions or /auth/refresh. */
export const BEARER_AUTH = 'bearerAuth';
/** Bearer identity token issued by POST /auth/otp/verify, valid only for onboarding. */
export const IDENTITY_AUTH = 'identityAuth';

registry.registerComponent('securitySchemes', BEARER_AUTH, {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Tenant-scoped access token from `POST /v1/auth/sessions` or `POST /v1/auth/refresh`.',
});
registry.registerComponent('securitySchemes', IDENTITY_AUTH, {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Identity token from `POST /v1/auth/otp/verify`. Proves the phone number only; it carries no tenant and is accepted by the onboarding routes alone.',
});

export const accessTokenSecurity = [{ [BEARER_AUTH]: [] }];
export const identityTokenSecurity = [{ [IDENTITY_AUTH]: [] }];

// --- Shared primitives ---------------------------------------------------

export const uuid = z.string().uuid().openapi({ format: 'uuid' });
export const timestamp = z
  .string()
  .datetime({ offset: true })
  .openapi({ format: 'date-time', description: 'ISO-8601 instant with offset.' });
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ format: 'date', description: 'Calendar date, YYYY-MM-DD, no timezone.' });
export const paise = z
  .number()
  .int()
  .openapi({ description: 'Integer paise (₹1 = 100). Never a decimal rupee amount.' });
export const quantity = z
  .number()
  .int()
  .openapi({ description: 'Integer thousandths of a unit (1 unit = 1000).' });
export const percent = z.number().openapi({ description: 'Percentage, e.g. 18 or 0.25.' });

// --- Envelopes -------------------------------------------------------------

export function dataEnvelope<T extends ZodTypeAny>(schema: T) {
  return z.object({ data: schema });
}

export function pageEnvelope<T extends ZodTypeAny>(schema: T) {
  return z.object({
    data: z.array(schema),
    nextCursor: z.string().nullable().openapi({
      description:
        'Opaque cursor for the next page, or null on the last page. Pass it back as `?cursor=`.',
    }),
  });
}

export function jsonResponse(description: string, schema: ZodTypeAny): ResponseConfig {
  return { description, content: { 'application/json': { schema } } };
}

export function noContent(description: string): ResponseConfig {
  return { description };
}
