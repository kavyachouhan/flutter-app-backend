import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as paymentsService from './payments.service.js';
import { createReceiptBody, listPaymentsQuery, voidPaymentBody } from './payments.schemas.js';

export const paymentsRouter: Router = Router();

const list = { query: listPaymentsQuery };
paymentsRouter.get('/', requirePermission('payments:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await paymentsService.listPayments(query));
});

const byId = { params: idParams };
paymentsRouter.get('/:id', requirePermission('payments:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await paymentsService.getPayment(params.id) });
});

const create = { body: createReceiptBody };
paymentsRouter.post(
  '/',
  requirePermission('payments:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    res.status(201).json({ data: await paymentsService.createReceipt(body) });
  },
);

const voidSchemas = { params: idParams, body: voidPaymentBody };
paymentsRouter.post(
  '/:id/void',
  requirePermission('payments:void'),
  validate(voidSchemas),
  async (req, res) => {
    const { params, body } = validated<typeof voidSchemas>(req);
    res.json({ data: await paymentsService.voidReceipt(params.id, body.reason) });
  },
);
