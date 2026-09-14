/**
 * Liveness, readiness and metrics.
 *
 * The distinction between the first two matters under an orchestrator:
 *
 *   /healthz  — is the process alive? Touches nothing external. A failure
 *               means "restart me". If this checked the database, a brief
 *               Postgres blip would cause every container to be killed and
 *               restarted, turning a recoverable dependency failure into a
 *               full outage.
 *
 *   /readyz   — can this instance serve traffic? Checks Postgres and Redis. A
 *               failure means "take me out of the load balancer", not
 *               "restart me". Redis being down is reported but does NOT fail
 *               readiness: the API is designed to degrade without it.
 */
import { Router } from 'express';
import { register as metricsRegistry } from 'prom-client';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { checkDatabaseHealth } from '../../db/pool.js';
import { checkRedisHealth } from '../../cache/redis.js';

export const healthRouter: Router = Router();

const startedAt = Date.now();

/** Liveness. Deliberately dependency-free and always cheap. */
healthRouter.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'khata-api',
    version: env.version,
    env: env.APP_ENV,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

/** Readiness. Fails only on Postgres, which the API genuinely cannot serve without. */
healthRouter.get(
  '/readyz',
  asyncHandler(async (_req, res) => {
    const [database, cache] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);

    const ready = database.ok;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      version: env.version,
      checks: {
        database,
        // Surfaced so a degraded cache is visible on a dashboard even though
        // it does not remove the instance from rotation.
        cache: { ...cache, required: false },
      },
    });
  }),
);

/**
 * Prometheus scrape endpoint. Not mounted under /v1 — metrics are an
 * operational concern with their own lifecycle, not part of the client API.
 */
if (env.METRICS_ENABLED) {
  healthRouter.get(
    '/metrics',
    asyncHandler(async (_req, res) => {
      res.setHeader('Content-Type', metricsRegistry.contentType);
      res.send(await metricsRegistry.metrics());
    }),
  );
}
