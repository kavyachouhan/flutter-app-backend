import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as numberingService from './numbering.service.js';
import { createSeriesBody, leaseBody, listSeriesQuery } from './numbering.schemas.js';

export const numberingRouter: Router = Router();

const list = { query: listSeriesQuery };
numberingRouter.get(
  '/series',
  requirePermission('numbering:read'),
  validate(list),
  async (req, res) => {
    const { query } = validated<typeof list>(req);
    res.json({ data: await numberingService.listSeries(query) });
  },
);

const create = { body: createSeriesBody };
numberingRouter.post(
  '/series',
  requirePermission('numbering:manage'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    res.status(201).json({ data: await numberingService.createSeries(body) });
  },
);

const lease = { params: idParams, body: leaseBody };
numberingRouter.post(
  '/series/:id/leases',
  requirePermission('numbering:lease'),
  validate(lease),
  async (req, res) => {
    const { params, body } = validated<typeof lease>(req);
    res.status(201).json({ data: await numberingService.leaseBlock(params.id, body) });
  },
);

const byId = { params: idParams };
numberingRouter.get(
  '/series/:id/gaps',
  requirePermission('numbering:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await numberingService.listGaps(params.id) });
  },
);

numberingRouter.get('/leases', requirePermission('numbering:lease'), async (_req, res) => {
  res.json({ data: await numberingService.listMyLeases() });
});
