import { z } from 'zod';
import { env } from '../../config/env.js';
import { jsonResponse, registry } from '../../openapi/registry.js';

const liveness = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int(),
});

const check = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
  required: z.boolean().optional(),
});

const readiness = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: check, cache: check }),
});

registry.registerPath({
  method: 'get',
  path: '/healthz',
  tags: ['Health'],
  summary: 'Liveness',
  description: 'Answers without touching any dependency.',
  responses: { 200: jsonResponse('Process is up.', liveness) },
});

registry.registerPath({
  method: 'get',
  path: '/readyz',
  tags: ['Health'],
  summary: 'Readiness',
  description: 'Fails only when Postgres is unreachable; Redis is reported but not required.',
  responses: {
    200: jsonResponse('Ready to serve.', readiness),
    503: jsonResponse('Postgres unreachable.', readiness),
  },
});

if (env.METRICS_ENABLED) {
  registry.registerPath({
    method: 'get',
    path: '/metrics',
    tags: ['Health'],
    summary: 'Prometheus metrics',
    responses: {
      200: {
        description: 'Prometheus exposition format.',
        content: { 'text/plain': { schema: z.string() } },
      },
    },
  });
}
