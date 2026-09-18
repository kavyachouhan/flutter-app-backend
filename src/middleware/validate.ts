/**
 * Request validation. Parsed values go on `req.valid` because Express 5 makes
 * `req.query` a getter that cannot be replaced.
 *
 * Unknown keys are stripped, not rejected: a newer app build sending an extra
 * field must not break against an older API, and installed apps cannot be
 * force-updated.
 */
import type { Request, RequestHandler } from 'express';
import type { ZodError, ZodTypeAny, z } from 'zod';
import { ValidationError } from '../lib/errors.js';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export interface Validated<S extends ValidationSchemas> {
  body: S['body'] extends ZodTypeAny ? z.infer<S['body']> : undefined;
  query: S['query'] extends ZodTypeAny ? z.infer<S['query']> : undefined;
  params: S['params'] extends ZodTypeAny ? z.infer<S['params']> : undefined;
}

declare module 'express-serve-static-core' {
  interface Request {
    valid?: unknown;
  }
}

function collect(error: ZodError, source: string, into: Record<string, string>): void {
  for (const issue of error.issues) {
    const key = [source, ...issue.path].join('.');
    into[key] ??= issue.message;
  }
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const fields: Record<string, string> = {};
    const valid: Record<string, unknown> = {};

    // All sources are checked before failing so the client sees every problem at once.
    for (const source of ['body', 'query', 'params'] as const) {
      const schema = schemas[source];
      if (!schema) continue;
      const result = schema.safeParse(req[source]);
      if (result.success) valid[source] = result.data;
      else collect(result.error, source, fields);
    }

    if (Object.keys(fields).length > 0) {
      next(new ValidationError(undefined, { details: { fields } }));
      return;
    }
    req.valid = valid;
    next();
  };
}

export function validated<S extends ValidationSchemas>(req: Request): Validated<S> {
  if (req.valid === undefined) {
    throw new Error(`${req.method} ${req.path} read req.valid without validate() middleware.`);
  }
  return req.valid as Validated<S>;
}
