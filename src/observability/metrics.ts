/**
 * Prometheus metrics.
 *
 * Kept small on purpose. Every label value becomes a separate time series, so
 * high-cardinality labels (tenant id, invoice id, raw URL) would multiply the
 * series count until the scrape itself becomes the problem. Routes are
 * labelled by their *pattern* (`/v1/invoices/:id`), never the resolved path.
 */
import { Counter, Histogram, collectDefaultMetrics, register } from 'prom-client';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

if (env.METRICS_ENABLED) {
  collectDefaultMetrics({ register, prefix: 'khata_' });
}

export const httpRequestDuration = new Histogram({
  name: 'khata_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  // Buckets chosen around the SLOs that matter for a POS: a bill must post in
  // well under a second, and anything past 5s is a user watching a spinner.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: 'khata_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

/** Business counters. These are what a dashboard is actually built from. */
export const businessEvents = new Counter({
  name: 'khata_business_events_total',
  help: 'Domain events (invoices issued, syncs applied, documents voided)',
  labelNames: ['event', 'outcome'] as const,
  registers: [register],
});

/**
 * Resolves the route *pattern* from the Express layer stack.
 *
 * `req.route` is only populated once a handler matches, so this runs on
 * response finish rather than on request start. Unmatched requests collapse
 * into a single `unmatched` series, which stops a scanner probing thousands of
 * random paths from creating thousands of time series.
 */
function routeLabel(req: Parameters<RequestHandler>[0]): string {
  // `req.route` is typed loosely by @types/express, so narrow it explicitly
  // rather than trusting the shape.
  const route: unknown = req.route;
  const base = req.baseUrl || '';

  if (typeof route === 'object' && route !== null && 'path' in route) {
    const path: unknown = route.path;
    if (typeof path === 'string') return `${base}${path}` || '/';
  }

  return base || 'unmatched';
}

export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (!env.METRICS_ENABLED) {
      next();
      return;
    }

    const endTimer = httpRequestDuration.startTimer();

    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: routeLabel(req),
        status: String(res.statusCode),
      };
      endTimer(labels);
      httpRequestsTotal.inc(labels);
    });

    next();
  };
}
