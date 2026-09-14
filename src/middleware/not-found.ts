/**
 * Terminal 404 handler, mounted after every route.
 *
 * Without it Express emits its own HTML error page, which breaks a JSON client
 * that is trying to parse the body — a mistyped URL would surface in Flutter
 * as a confusing decode exception instead of a clean 404.
 */
import type { RequestHandler } from 'express';
import { NotFoundError } from '../lib/errors.js';

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path}`));
  };
}
