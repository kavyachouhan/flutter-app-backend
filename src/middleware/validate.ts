/**
 * Request validation via Zod.
 *
 * Every route declares a schema for whichever of body/query/params it reads,
 * and the *parsed* value replaces the raw one. That matters more than it
 * looks: after validation, `req.valid.body` is fully typed and coerced, so
 * handlers never re-check a field or parse a numeric query string by hand.
 *
 * Unknown keys are stripped rather than rejected. A rejection would break
 * older mobile clients the moment a newer one starts sending a new field, and
 * those clients cannot be force-updated.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ValidationError } from '../lib/errors.js';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  headers?: ZodTypeAny;
}

/** The validated payload, attached to the request as `req.valid`. */
export interface ValidatedRequest<S extends ValidationSchemas> {
  body: S['body'] extends ZodTypeAny ? z.infer<S['body']> : undefined;
  query: S['query'] extends ZodTypeAny ? z.infer<S['query']> : undefined;
  params: S['params'] extends ZodTypeAny ? z.infer<S['params']> : undefined;
  headers: S['headers'] extends ZodTypeAny ? z.infer<S['headers']> : undefined;
}

declare module 'express-serve-static-core' {
  interface Request {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    valid?: ValidatedRequest<any>;
  }
}

function flatten(error: ZodError, source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    const key = path ? `${source}.${path}` : source;
    fields[key] ??= issue.message;
  }
  return fields;
}

export function validate<S extends ValidationSchemas>(schemas: S): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const fields: Record<string, string> = {};
    const valid: Record<string, unknown> = {};

    // All four sources are checked before returning, so a client fixing a
    // request sees every problem at once instead of one per round-trip.
    for (const source of ['body', 'query', 'params', 'headers'] as const) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (result.success) {
        valid[source] = result.data;
      } else {
        Object.assign(fields, flatten(result.error, source));
      }
    }

    if (Object.keys(fields).length > 0) {
      next(new ValidationError('The request failed validation.', { details: { fields } }));
      return;
    }

    // `req.query` and `req.params` have getter-only definitions in Express 4,
    // so the coerced values go on `req.valid` rather than overwriting them.
    // Built key-by-key above from the schemas in `S`, so the shape is correct
    // by construction; TypeScript cannot follow that, hence the assertion.
    req.valid = valid as unknown as ValidatedRequest<S>;
    next();
  };
}

/**
 * Typed accessor used inside handlers:
 *
 *   const { body } = validated<typeof schemas>(req);
 *
 * Throws rather than returning undefined: a missing `req.valid` means the
 * route forgot its `validate()` middleware, which is a wiring bug we want to
 * fail loudly in development rather than read as an empty body.
 */
export function validated<S extends ValidationSchemas>(req: Request): ValidatedRequest<S> {
  if (!req.valid) {
    throw new Error(
      `Route ${req.method} ${req.path} read req.valid without a validate() middleware.`,
    );
  }
  return req.valid as ValidatedRequest<S>;
}
