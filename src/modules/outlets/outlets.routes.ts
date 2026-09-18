import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as outletsService from './outlets.service.js';
import {
  createCounterBody,
  createOutletBody,
  listCountersQuery,
  updateCounterBody,
  updateOutletBody,
} from './outlets.schemas.js';

export const outletsRouter: Router = Router();

outletsRouter.get('/outlets', requirePermission('tenant:read'), async (_req, res) => {
  res.json({ data: await outletsService.listOutlets() });
});

const createOutlet = { body: createOutletBody };
outletsRouter.post(
  '/outlets',
  requirePermission('outlets:manage'),
  validate(createOutlet),
  async (req, res) => {
    const { body } = validated<typeof createOutlet>(req);
    res.status(201).json({ data: await outletsService.createOutlet(body) });
  },
);

const updateOutlet = { params: idParams, body: updateOutletBody };
outletsRouter.patch(
  '/outlets/:id',
  requirePermission('outlets:manage'),
  validate(updateOutlet),
  async (req, res) => {
    const { params, body } = validated<typeof updateOutlet>(req);
    res.json({ data: await outletsService.updateOutlet(params.id, body) });
  },
);

const byId = { params: idParams };
outletsRouter.delete(
  '/outlets/:id',
  requirePermission('outlets:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await outletsService.deleteOutlet(params.id);
    res.status(204).end();
  },
);

const listCounters = { query: listCountersQuery };
outletsRouter.get(
  '/counters',
  requirePermission('tenant:read'),
  validate(listCounters),
  async (req, res) => {
    const { query } = validated<typeof listCounters>(req);
    res.json({ data: await outletsService.listCounters(query.outletId) });
  },
);

const createCounter = { body: createCounterBody };
outletsRouter.post(
  '/counters',
  requirePermission('counters:manage'),
  validate(createCounter),
  async (req, res) => {
    const { body } = validated<typeof createCounter>(req);
    res.status(201).json({ data: await outletsService.createCounter(body) });
  },
);

const updateCounter = { params: idParams, body: updateCounterBody };
outletsRouter.patch(
  '/counters/:id',
  requirePermission('counters:manage'),
  validate(updateCounter),
  async (req, res) => {
    const { params, body } = validated<typeof updateCounter>(req);
    res.json({ data: await outletsService.updateCounter(params.id, body) });
  },
);

outletsRouter.delete(
  '/counters/:id',
  requirePermission('counters:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await outletsService.deleteCounter(params.id);
    res.status(204).end();
  },
);
