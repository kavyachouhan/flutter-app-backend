import { Router } from 'express';
import { idParams } from '../../../lib/validators.js';
import { requirePermission } from '../../../middleware/authorize.js';
import { validate, validated } from '../../../middleware/validate.js';
import * as advances from './advances.service.js';
import {
  adjustAdvanceBody,
  createReceiptVoucherBody,
  listReceiptVouchersQuery,
  refundAdvanceBody,
} from './advances.schemas.js';

/** Mounted at /v1/gst/advances. */
export const advancesRouter: Router = Router();

const create = { body: createReceiptVoucherBody };
advancesRouter.post('/receipt-vouchers', requirePermission('payments:create'), validate(create), async (req, res) => {
  const { body } = validated<typeof create>(req);
  res.status(201).json({ data: await advances.createReceiptVoucher(body) });
});

const list = { query: listReceiptVouchersQuery };
advancesRouter.get('/receipt-vouchers', requirePermission('payments:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json({ data: await advances.listReceiptVouchers(query) });
});

const refund = { params: idParams, body: refundAdvanceBody };
advancesRouter.post('/receipt-vouchers/:id/refund', requirePermission('payments:create'), validate(refund), async (req, res) => {
  const { params, body } = validated<typeof refund>(req);
  res.status(201).json({ data: await advances.refundAdvance(params.id, body) });
});

const adjust = { params: idParams, body: adjustAdvanceBody };
advancesRouter.post('/receipt-vouchers/:id/adjust', requirePermission('payments:create'), validate(adjust), async (req, res) => {
  const { params, body } = validated<typeof adjust>(req);
  res.status(201).json({ data: await advances.adjustAdvance(params.id, body) });
});

const byId = { params: idParams };
advancesRouter.post('/receipt-vouchers/:id/void', requirePermission('payments:void'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await advances.voidReceiptVoucher(params.id) });
});
