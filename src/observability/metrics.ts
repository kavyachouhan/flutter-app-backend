import { Counter, Histogram, collectDefaultMetrics, register } from 'prom-client';
import type { Request, RequestHandler } from 'express';
import { env } from '../config/env.js';

if (env.METRICS_ENABLED) {
  collectDefaultMetrics({ register, prefix: env.METRICS_PREFIX });
}

const httpRequestDuration = new Histogram({
  name: `${env.METRICS_PREFIX}http_request_duration_seconds`,
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: env.METRICS_LATENCY_BUCKETS_SECONDS,
  registers: [register],
});

export const businessEvents = new Counter({
  name: `${env.METRICS_PREFIX}business_events_total`,
  help: 'Domain events such as invoices issued and voided',
  labelNames: ['event'] as const,
  registers: [register],
});

// One series per provider and outcome: a rising `terminal_error` rate is a
// misconfigured template or sender; a rising `retryable_error` rate is the
// vendor. Both are the first thing to check when sign-ins drop.
export const otpDeliveries = new Counter({
  name: `${env.METRICS_PREFIX}otp_deliveries_total`,
  help: 'OTP delivery attempts by provider and outcome',
  labelNames: ['provider', 'result'] as const,
  registers: [register],
});

// A rising `rejected` rate on one operation type is the first sign of a
// client/server drift (e.g. tax engine mismatch) in the field.
export const syncOperations = new Counter({
  name: `${env.METRICS_PREFIX}sync_operations_total`,
  help: 'Pushed sync operations by type and outcome',
  labelNames: ['type', 'result'] as const,
  registers: [register],
});

export const syncPullChanges = new Counter({
  name: `${env.METRICS_PREFIX}sync_pull_changes_total`,
  help: 'Rows emitted by the change feed, by entity',
  labelNames: ['entity'] as const,
  registers: [register],
});

// Routes are labelled by pattern, never by resolved path: each distinct label
// value is a separate time series, and a scanner probing random URLs would
// otherwise create thousands of them.
function routeLabel(req: Request): string {
  const route: unknown = req.route;
  if (
    typeof route === 'object' &&
    route !== null &&
    'path' in route &&
    typeof route.path === 'string'
  ) {
    return `${req.baseUrl}${route.path}`;
  }
  return 'unmatched';
}

export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (!env.METRICS_ENABLED) {
      next();
      return;
    }
    const endTimer = httpRequestDuration.startTimer();
    res.on('finish', () => {
      endTimer({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
    });
    next();
  };
}
