import type { RequestHandler } from 'express';
import { NotFoundError } from '../lib/errors.js';

// Without this Express answers with an HTML page, which a JSON client reports
// as a decode failure rather than a 404.
export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path}`));
  };
}
