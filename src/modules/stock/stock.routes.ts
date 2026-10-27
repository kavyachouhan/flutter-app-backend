import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { reconcileReservations } from '../sales-orders/sales-orders.service.js';
import * as stockService from './stock.service.js';
import { createAdjustmentBody, ledgerQuery, listBalancesQuery } from './stock.schemas.js';

export const stockRouter: Router = Router();

const balances = { query: listBalancesQuery };
stockRouter.get(
  '/balances',
  requirePermission('stock:read'),
  validate(balances),
  async (req, res) => {
    const { query } = validated<typeof balances>(req);
    res.json(await stockService.listBalances(query));
  },
);

const ledger = { query: ledgerQuery };
stockRouter.get('/ledger', requirePermission('stock:read'), validate(ledger), async (req, res) => {
  const { query } = validated<typeof ledger>(req);
  res.json(await stockService.listLedger(query));
});

const adjust = { body: createAdjustmentBody };
stockRouter.post(
  '/adjustments',
  requirePermission('stock:adjust'),
  validate(adjust),
  async (req, res) => {
    const { body } = validated<typeof adjust>(req);
    res.status(201).json({ data: await stockService.createAdjustment(body) });
  },
);

// Checks the reserved column against the open sales orders' lines, and can rewrite it.
// The incremental path keeps them equal; this is how that is proven, and the repair if a
// bug ever let them part. Gated like the orders it audits.
const reconcile = {
  body: z.object({ outletId: z.string().uuid().optional(), repair: z.boolean().default(false) }),
};
stockRouter.post(
  '/reservations/reconcile',
  requirePermission('stock:adjust'),
  validate(reconcile),
  async (req, res) => {
    const { body } = validated<typeof reconcile>(req);
    res.json({ data: await reconcileReservations(body) });
  },
);
