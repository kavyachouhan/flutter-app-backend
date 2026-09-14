/**
 * Express application assembly.
 *
 * Wiring only — no business logic, no listening. Keeping `listen()` out of
 * this file is what lets the integration suite import the app and drive it
 * with supertest without binding a port.
 *
 * MIDDLEWARE ORDER IS LOAD-BEARING. Read the comments before reordering:
 * several of these are only correct in the position they occupy.
 */
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';

import { env } from './config/env.js';
import { requestContext } from './middleware/request-context.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { metricsMiddleware } from './observability/metrics.js';
import { healthRouter } from './modules/health/routes.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('app');

export function createApp(): Express {
  const app = express();

  // --- Proxy awareness ----------------------------------------------------
  // Must come first: `req.ip` feeds rate limiting, and behind a load balancer
  // an untrusted `req.ip` means every request appears to come from the proxy,
  // collapsing per-IP limits into one shared bucket.
  //
  // A *number* of hops, never `true`. `trust proxy: true` makes Express
  // believe the leftmost X-Forwarded-For entry, which the client controls —
  // so anyone could spoof an IP and evade rate limiting entirely.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  // Removes the `X-Powered-By: Express` fingerprint. helmet does this too;
  // set explicitly so it survives a helmet configuration change.
  app.disable('x-powered-by');

  // Treats `/invoices` and `/invoices/` as one route, so metrics and caches
  // do not split across a trailing slash.
  app.set('strict routing', false);

  // --- Observability ------------------------------------------------------
  // Before everything else that can fail, so nothing is invisible in the logs.
  app.use(requestContext());
  app.use(metricsMiddleware());

  // --- Security headers ---------------------------------------------------
  app.use(
    helmet({
      // This is a JSON API, not a site: the browser-facing policies mostly do
      // not apply. CSP is scoped to the one HTML surface we serve (/docs).
      contentSecurityPolicy: env.DOCS_ENABLED
        ? {
            directives: {
              defaultSrc: ["'self'"],
              // Swagger UI injects its own styles and an init script.
              styleSrc: ["'self'", "'unsafe-inline'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,

      // Cross-origin isolation headers would block the Flutter web client
      // from reading responses; the API is protected by CORS and bearer
      // tokens instead.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,

      // HSTS only where TLS actually terminates in front of us.
      hsts: env.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,

      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // --- CORS ---------------------------------------------------------------
  // Native Flutter clients send no Origin header at all and are unaffected by
  // CORS; this exists for the future React web app and for /docs.
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin: a native app, a server-to-server call, or curl. CORS is a
        // browser mechanism, so there is nothing to enforce.
        if (!origin) {
          callback(null, true);
          return;
        }
        if (env.CORS_ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        log.warn({ origin }, 'Blocked a cross-origin request from an unlisted origin');
        // `false`, not an Error: an Error becomes a 500, when the correct
        // outcome is simply omitting the CORS headers so the browser blocks it.
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Request-Id',
        'X-Device-Id',
        'Idempotency-Key',
        'If-None-Match',
      ],
      // Clients must be able to read these to correlate and to cache.
      exposedHeaders: ['X-Request-Id', 'ETag', 'Retry-After'],
      maxAge: 86_400,
    }),
  );

  // --- Compression --------------------------------------------------------
  // Sync pulls and report payloads compress extremely well, and the clients
  // this serves are often on patchy mobile data where bytes are the cost.
  app.use(
    compression({
      // Below ~1KB the CPU and the extra packet cost more than the saving.
      threshold: 1024,
    }),
  );

  // --- Health -------------------------------------------------------------
  // Mounted before body parsing and auth: a probe must not depend on either,
  // and /healthz must stay answerable when everything downstream is broken.
  app.use(healthRouter);

  // --- Body parsing -------------------------------------------------------
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  // --- API ----------------------------------------------------------------
  // Domain routers mount here as they land (M2 onward):
  //   app.use('/v1', v1Router);

  // --- Terminal handlers --------------------------------------------------
  // Order is mandatory: 404 before the error handler, error handler last.
  // Express identifies the error handler purely by its four-argument
  // signature, and anything mounted after it never runs.
  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
