import { Router } from 'express';
import { env } from '../../config/env.js';
import { getContext } from '../../lib/context.js';
import { requirePermission } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import { pullQuery, pushBody } from './sync.schemas.js';
import * as syncService from './sync.service.js';

export const syncRouter: Router = Router();

// Per device: one runaway till must not starve the rest of the shop.
syncRouter.use(
  rateLimit({
    name: 'sync',
    points: env.RATE_LIMIT_SYNC_POINTS,
    windowSeconds: env.RATE_LIMIT_SYNC_WINDOW_SECONDS,
    key: () => getContext()?.deviceId,
  }),
);

const pull = { query: pullQuery };
syncRouter.get('/changes', requirePermission('sync:read'), validate(pull), async (req, res) => {
  const { query } = validated<typeof pull>(req);
  res.json({ data: await syncService.pullChanges(query) });
});

// Always 200: the per-operation status is the contract. Idempotency-Key is
// deliberately not used here — a batch is partially retryable.
const push = { body: pushBody };
syncRouter.post('/push', requirePermission('sync:write'), validate(push), async (req, res) => {
  const { body } = validated<typeof push>(req);
  res.json({ data: await syncService.pushOperations(body) });
});

syncRouter.get('/state', requirePermission('sync:read'), async (_req, res) => {
  res.json({ data: await syncService.getState() });
});
