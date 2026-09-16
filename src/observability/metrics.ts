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
