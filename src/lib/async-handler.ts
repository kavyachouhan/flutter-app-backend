/**
 * Express 5 forwards a rejected promise from a route handler to the error
 * middleware automatically, so the `.catch(next)` wrapper that Express 4
 * required is gone.
 *
 * This module keeps only the type alias, so handlers can be written as
 * ordinary async functions and still be checked against the right signature:
 *
 *   router.get('/:id', validate(schemas), (async (req, res) => { ... }) satisfies AsyncHandler);
 *
 * The safety net is now the lint rule `@typescript-eslint/no-floating-promises`,
 * which catches a promise dropped *inside* a handler — the one case Express
 * still cannot see.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Identity wrapper, retained so existing call sites read consistently and so
 * there is one obvious place to add per-handler instrumentation later.
 * It no longer catches anything — Express 5 does that.
 */
export function asyncHandler(handler: AsyncHandler): RequestHandler {
  return handler as RequestHandler;
}
