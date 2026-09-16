import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
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
