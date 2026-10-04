import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { listReturnable } from '../debit-notes/debit-notes.service.js';
import * as orders from './orders.service.js';
import * as purchases from './purchases.service.js';
import {
  cancelPurchaseOrderBody,
  createPurchaseBillBody,
  createPurchaseOrderBody,
  createSupplierPaymentBody,
  listPurchaseBillsQuery,
  listPurchaseOrdersQuery,
  listSupplierPaymentsQuery,
  voidPurchaseBillBody,
  voidSupplierPaymentBody,
} from './purchases.schemas.js';

export const purchaseBillsRouter: Router = Router();
export const purchaseOrdersRouter: Router = Router();
export const supplierPaymentsRouter: Router = Router();

// --- Purchase bills --------------------------------------------------------

const listBills = { query: listPurchaseBillsQuery };
purchaseBillsRouter.get(
  '/',
  requirePermission('purchases:read'),
  validate(listBills),
  async (req, res) => {
    const { query } = validated<typeof listBills>(req);
    res.json(await purchases.listPurchaseBills(query));
  },
);

// 200 on a replay so a client can tell a retry from a first write, as with
// sales invoices.
const createBill = { body: createPurchaseBillBody };
purchaseBillsRouter.post(
  '/',
  requirePermission('purchases:create'),
  validate(createBill),
  async (req, res) => {
    const { body } = validated<typeof createBill>(req);
    const { bill, replayed } = await purchases.createPurchaseBill(body);
    res.status(replayed ? 200 : 201).json({ data: bill, replayed });
  },
);

const byId = { params: idParams };
purchaseBillsRouter.get(
  '/:id',
  requirePermission('purchases:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await purchases.getPurchaseBill(params.id) });
  },
);

// Mirrors /invoices/:id/returnable: what can still be sent back, and how
// much of each line has already gone.
purchaseBillsRouter.get(
  '/:id/returnable',
  requirePermission('debit_notes:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await listReturnable(params.id) });
  },
);

const voidBill = { params: idParams, body: voidPurchaseBillBody };
purchaseBillsRouter.post(
  '/:id/void',
  requirePermission('purchases:void'),
  validate(voidBill),
  async (req, res) => {
    const { params, body } = validated<typeof voidBill>(req);
    res.json({ data: await purchases.voidPurchaseBill(params.id, body.reason) });
  },
);

// --- Purchase orders -------------------------------------------------------

const listOrders = { query: listPurchaseOrdersQuery };
purchaseOrdersRouter.get(
  '/',
  requirePermission('purchases:read'),
  validate(listOrders),
  async (req, res) => {
    const { query } = validated<typeof listOrders>(req);
    res.json(await orders.listPurchaseOrders(query));
  },
);

const createOrder = { body: createPurchaseOrderBody };
purchaseOrdersRouter.post(
  '/',
  requirePermission('purchases:create'),
  validate(createOrder),
  async (req, res) => {
    const { body } = validated<typeof createOrder>(req);
    res.status(201).json({ data: await orders.createPurchaseOrder(body) });
  },
);

purchaseOrdersRouter.get(
  '/:id',
  requirePermission('purchases:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await orders.getPurchaseOrder(params.id) });
  },
);

const cancelOrder = { params: idParams, body: cancelPurchaseOrderBody };
purchaseOrdersRouter.post(
  '/:id/cancel',
  requirePermission('purchases:create'),
  validate(cancelOrder),
  async (req, res) => {
    const { params, body } = validated<typeof cancelOrder>(req);
    res.json({ data: await orders.cancelPurchaseOrder(params.id, body.reason) });
  },
);

// --- Supplier payments -----------------------------------------------------

const listPayments = { query: listSupplierPaymentsQuery };
supplierPaymentsRouter.get(
  '/',
  requirePermission('purchases:read'),
  validate(listPayments),
  async (req, res) => {
    const { query } = validated<typeof listPayments>(req);
    res.json(await purchases.listSupplierPayments(query));
  },
);

const createPayment = { body: createSupplierPaymentBody };
supplierPaymentsRouter.post(
  '/',
  requirePermission('purchases:create'),
  validate(createPayment),
  async (req, res) => {
    const { body } = validated<typeof createPayment>(req);
    res.status(201).json({ data: await purchases.createSupplierPayment(body) });
  },
);

const voidPayment = { params: idParams, body: voidSupplierPaymentBody };
supplierPaymentsRouter.post(
  '/:id/void',
  requirePermission('purchases:void'),
  validate(voidPayment),
  async (req, res) => {
    const { params, body } = validated<typeof voidPayment>(req);
    res.json({ data: await purchases.voidSupplierPayment(params.id, body.reason) });
  },
);
