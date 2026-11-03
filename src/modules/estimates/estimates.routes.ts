import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { buildEstimatePayload } from '../print/print.service.js';
import { printPayloadQuery } from '../print/print.schemas.js';
import * as estimates from './estimates.service.js';
import {
  cancelEstimateBody,
  convertEstimateBody,
  createEstimateBody,
  listEstimatesQuery,
  summaryEstimatesQuery,
  updateEstimateBody,
} from './estimates.schemas.js';

export const estimatesRouter: Router = Router();

const summary = { query: summaryEstimatesQuery };
estimatesRouter.get(
  '/summary',
  requirePermission('estimates:read'),
  validate(summary),
  async (req, res) => {
    const { query } = validated<typeof summary>(req);
    res.json({ data: await estimates.summaryEstimates(query) });
  },
);

const list = { query: listEstimatesQuery };
estimatesRouter.get('/', requirePermission('estimates:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await estimates.listEstimates(query));
});

// 200 on a replay so a client can tell a retry from a first write, as with orders.
const create = { body: createEstimateBody };
estimatesRouter.post(
  '/',
  requirePermission('estimates:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    const { estimate, replayed } = await estimates.createEstimate(body);
    res.status(replayed ? 200 : 201).json({ data: estimate, replayed });
  },
);

const byId = { params: idParams };
estimatesRouter.get(
  '/:id',
  requirePermission('estimates:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await estimates.getEstimate(params.id) });
  },
);

// The whole estimate, formatted and ready to print or share.
const printPayload = { params: idParams, query: printPayloadQuery };
estimatesRouter.get(
  '/:id/print-payload',
  requirePermission('estimates:read'),
  validate(printPayload),
  async (req, res) => {
    const { params, query } = validated<typeof printPayload>(req);
    res.json({ data: await buildEstimatePayload(params.id, query) });
  },
);

const update = { params: idParams, body: updateEstimateBody };
estimatesRouter.put(
  '/:id',
  requirePermission('estimates:update'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    const { estimate } = await estimates.updateEstimate(params.id, body);
    res.json({ data: estimate });
  },
);

const remove = { params: idParams };
estimatesRouter.delete(
  '/:id',
  requirePermission('estimates:delete'),
  validate(remove),
  async (req, res) => {
    const { params } = validated<typeof remove>(req);
    await estimates.deleteEstimate(params.id);
    res.status(204).end();
  },
);

const cancel = { params: idParams, body: cancelEstimateBody };
estimatesRouter.post(
  '/:id/cancel',
  requirePermission('estimates:update'),
  validate(cancel),
  async (req, res) => {
    const { params, body } = validated<typeof cancel>(req);
    res.json({ data: await estimates.cancelEstimate(params.id, body) });
  },
);

estimatesRouter.post(
  '/:id/close',
  requirePermission('estimates:update'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await estimates.closeEstimate(params.id) });
  },
);

const convert = { params: idParams, body: convertEstimateBody };
estimatesRouter.post(
  '/:id/convert',
  requirePermission('estimates:convert'),
  validate(convert),
  async (req, res) => {
    const { params, body } = validated<typeof convert>(req);
    const { estimate, salesOrder, warnings } = await estimates.convertEstimateToSalesOrder(
      params.id,
      body,
    );
    res.status(201).json({ data: estimate, salesOrder, warnings });
  },
);
