import { Router } from 'express';
import { register as metricsRegistry } from 'prom-client';
import { env } from '../../config/env.js';
import { checkDatabaseHealth } from '../../db/pool.js';
import { checkRedisHealth } from '../../cache/redis.js';

export const healthRouter: Router = Router();

const startedAt = Date.now();

// Liveness must not touch dependencies: if it did, a short database blip
// would make the orchestrator restart every instance at once.
healthRouter.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: env.SERVICE_NAME,
    version: env.version,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// Readiness fails only on Postgres. The API degrades without Redis (see
// cache/redis.ts), so a Redis outage is reported but keeps the instance in rotation.
healthRouter.get('/readyz', async (_req, res) => {
  const [database, cache] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
  res.status(database.ok ? 200 : 503).json({
    status: database.ok ? 'ready' : 'not_ready',
    checks: { database, cache: { ...cache, required: false } },
  });
});

if (env.METRICS_ENABLED) {
  healthRouter.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
  });
}
