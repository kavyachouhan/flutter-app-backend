import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as deliveryChallans from './delivery-challans.service.js';
import {
  cancelDeliveryChallanBody,
  createDeliveryChallanBody,
  listDeliveryChallansQuery,
  updateDeliveryChallanBody,
} from './delivery-challans.schemas.js';

export const deliveryChallansRouter: Router = Router();

const list = { query: listDeliveryChallansQuery };
deliveryChallansRouter.get(
  '/',
  requirePermission('delivery_challans:read'),
  validate(list),
  async (req, res) => {
    const { query } = validated<typeof list>(req);
    res.json(await deliveryChallans.listDeliveryChallans(query));
  },
);

const create = { body: createDeliveryChallanBody };
deliveryChallansRouter.post(
  '/',
  requirePermission('delivery_challans:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    res.status(201).json({ data: await deliveryChallans.createDeliveryChallan(body) });
  },
);

const byId = { params: idParams };
deliveryChallansRouter.get(
  '/:id',
  requirePermission('delivery_challans:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await deliveryChallans.getDeliveryChallan(params.id) });
  },
);

const update = { params: idParams, body: updateDeliveryChallanBody };
deliveryChallansRouter.patch(
  '/:id',
  requirePermission('delivery_challans:create'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    res.json({ data: await deliveryChallans.updateDeliveryChallan(params.id, body) });
  },
);

const cancel = { params: idParams, body: cancelDeliveryChallanBody };
deliveryChallansRouter.post(
  '/:id/cancel',
  requirePermission('delivery_challans:void'),
  validate(cancel),
  async (req, res) => {
    const { params, body } = validated<typeof cancel>(req);
    res.json({ data: await deliveryChallans.cancelDeliveryChallan(params.id, body.reason) });
  },
);
