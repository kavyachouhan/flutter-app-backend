import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { buildSaleOrderPayload } from '../print/print.service.js';
import { printPayloadQuery } from '../print/print.schemas.js';
import * as orders from './sales-orders.service.js';
import {
  cancelSaleOrderBody,
  closeSaleOrderBody,
  createSaleOrderBody,
  deleteSaleOrderQuery,
  listSaleOrdersQuery,
  summarySaleOrdersQuery,
  updateSaleOrderBody,
} from './sales-orders.schemas.js';

export const salesOrdersRouter: Router = Router();

const summary = { query: summarySaleOrdersQuery };
salesOrdersRouter.get(
  '/summary',
  requirePermission('sales_orders:read'),
  validate(summary),
  async (req, res) => {
    const { query } = validated<typeof summary>(req);
    res.json({ data: await orders.summarySaleOrders(query) });
  },
);

const list = { query: listSaleOrdersQuery };
salesOrdersRouter.get(
  '/',
  requirePermission('sales_orders:read'),
  validate(list),
  async (req, res) => {
    const { query } = validated<typeof list>(req);
    res.json(await orders.listSaleOrders(query));
  },
);

// 200 on a replay so a client can tell a retry from a first write, as with invoices.
const create = { body: createSaleOrderBody };
salesOrdersRouter.post(
  '/',
  requirePermission('sales_orders:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    const { order, replayed, warnings } = await orders.createSaleOrder(body);
    res.status(replayed ? 200 : 201).json({ data: order, replayed, warnings });
  },
);

const byId = { params: idParams };
salesOrdersRouter.get(
  '/:id',
  requirePermission('sales_orders:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await orders.getSaleOrder(params.id) });
  },
);

// The whole order, formatted and ready to print or share.
const printPayload = { params: idParams, query: printPayloadQuery };
salesOrdersRouter.get(
  '/:id/print-payload',
  requirePermission('sales_orders:read'),
  validate(printPayload),
  async (req, res) => {
    const { params, query } = validated<typeof printPayload>(req);
    res.json({ data: await buildSaleOrderPayload(params.id, query) });
  },
);

const update = { params: idParams, body: updateSaleOrderBody };
salesOrdersRouter.put(
  '/:id',
  requirePermission('sales_orders:update'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    const { order, warnings } = await orders.updateSaleOrder(params.id, body);
    res.json({ data: order, warnings });
  },
);

// Deleting reverses nothing silently: an unused advance is paid back first, and the
// response says how. 200 with the refund when there was one, otherwise 204.
const remove = { params: idParams, query: deleteSaleOrderQuery };
salesOrdersRouter.delete(
  '/:id',
  requirePermission('sales_orders:delete'),
  validate(remove),
  async (req, res) => {
    const { params, query } = validated<typeof remove>(req);
    const { refund } = await orders.deleteSaleOrder(params.id, query);
    if (refund) res.json({ data: { deleted: true, refund } });
    else res.status(204).end();
  },
);

const cancel = { params: idParams, body: cancelSaleOrderBody };
salesOrdersRouter.post(
  '/:id/cancel',
  requirePermission('sales_orders:cancel'),
  validate(cancel),
  async (req, res) => {
    const { params, body } = validated<typeof cancel>(req);
    const { order, refund } = await orders.cancelSaleOrder(params.id, body);
    res.json({ data: order, refund });
  },
);

const close = { params: idParams, body: closeSaleOrderBody };
salesOrdersRouter.post(
  '/:id/close',
  requirePermission('sales_orders:cancel'),
  validate(close),
  async (req, res) => {
    const { params, body } = validated<typeof close>(req);
    const { order, refund } = await orders.closeSaleOrder(params.id, body);
    res.json({ data: order, refund });
  },
);
