/**
 * Establishes the per-request context and logs the request/response pair.
 *
 * Must be mounted before everything except helmet — the request id it creates
 * is what ties a client bug report to a server log line, and an error thrown
 * by an earlier middleware would have nothing to correlate.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext, type RequestContext } from '../lib/context.js';
import { logger } from '../lib/logger.js';

/** Header name used both for accepting an upstream id and echoing ours back. */
export const REQUEST_ID_HEADER = 'x-request-id';
export const DEVICE_ID_HEADER = 'x-device-id';

/**
 * An inbound request id is honoured so a trace can span the mobile client and
 * the API — but only if it looks sane. An unbounded attacker-controlled string
 * would be written into every log line, which is a log-injection vector.
 */
function resolveRequestId(req: Request): string {
  const inbound = req.header(REQUEST_ID_HEADER);
  if (inbound && /^[A-Za-z0-9._-]{8,128}$/.test(inbound)) return inbound;
  return randomUUID();
}

export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = resolveRequestId(req);
    const deviceId = req.header(DEVICE_ID_HEADER);

    const context: RequestContext = {
      requestId,
      method: req.method,
      path: req.path,
      startedAt: performance.now(),
    };
    if (deviceId && /^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) {
      context.deviceId = deviceId;
    }

    // Echoed before the handler runs so it is present even on a 500.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext(context, () => {
      // `finish` covers normal responses; `close` catches a client that hung
      // up mid-response, which otherwise vanishes from the logs entirely.
      let logged = false;
      const complete = (aborted: boolean) => {
        if (logged) return;
        logged = true;

        const durationMs = Math.round((performance.now() - context.startedAt) * 100) / 100;
        const status = res.statusCode;

        // 5xx is ours to fix, 4xx is the caller's; only 5xx deserves `error`.
        const level = aborted ? 'warn' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

        logger[level](
          {
            method: req.method,
            path: req.originalUrl,
            status,
            durationMs,
            ip: req.ip,
            userAgent: req.header('user-agent'),
            ...(aborted ? { aborted: true } : {}),
          },
          `${req.method} ${req.originalUrl} ${status} ${durationMs}ms`,
        );
      };

      res.on('finish', () => complete(false));
      res.on('close', () => complete(!res.writableEnded));

      next();
    });
  };
}
