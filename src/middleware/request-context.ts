import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext } from '../lib/context.js';
import { logger } from '../lib/logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

// An inbound id lets a trace span the app and the API, but it is written into
// every log line, so anything outside a conservative shape is replaced.
const INBOUND_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.header(REQUEST_ID_HEADER);
    const requestId = inbound && INBOUND_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const context = { requestId, startedAt: performance.now(), ip: req.ip };

    runWithContext(context, () => {
      let logged = false;
      const complete = (aborted: boolean) => {
        if (logged) return;
        logged = true;
        const durationMs = Math.round(performance.now() - context.startedAt);
        const status = res.statusCode;
        const level = aborted || status >= 400 ? (status >= 500 ? 'error' : 'warn') : 'info';
        logger[level](
          {
            method: req.method,
            path: req.originalUrl,
            status,
            durationMs,
            ...(aborted && { aborted }),
          },
          `${req.method} ${req.originalUrl} ${status}`,
        );
      };
      res.on('finish', () => complete(false));
      // A client that hangs up mid-response never emits 'finish'.
      res.on('close', () => complete(!res.writableEnded));
      next();
    });
  };
}
