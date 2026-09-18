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
import { createV1Router } from './v1-router.js';

/** Wiring only; `listen` lives in server.ts so tests can drive the app without a port. */
export function createApp(): Express {
  const app = express();

  // A hop count, never `true`: `true` trusts the client-controlled leftmost
  // X-Forwarded-For entry, letting anyone spoof their IP past rate limits.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(requestContext());
  app.use(metricsMiddleware());

  app.use(
    helmet({
      // JSON-only API: there is no HTML surface for a CSP to protect.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: env.isProduction
        ? { maxAge: env.HSTS_MAX_AGE_SECONDS, includeSubDomains: true }
        : false,
    }),
  );

  // Native Flutter apps send no Origin header and are unaffected; this governs
  // the future React web client.
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(null, !origin || env.CORS_ALLOWED_ORIGINS.includes(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit-Remaining'],
      maxAge: env.CORS_MAX_AGE_SECONDS,
    }),
  );

  app.use(compression({ threshold: env.COMPRESSION_THRESHOLD_BYTES }));

  // Before body parsing and auth, so probes keep answering when those break.
  app.use(healthRouter);

  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use('/v1', createV1Router());

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
