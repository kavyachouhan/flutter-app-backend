import { Router } from 'express';
import { idParams } from '../../../lib/validators.js';
import { requirePermission } from '../../../middleware/authorize.js';
import { validate, validated } from '../../../middleware/validate.js';
import * as amendments from './amendments.service.js';
import { createAmendmentBody, listAmendmentsQuery } from './amendments.schemas.js';

/** Mounted at /v1/gst/amendments. */
export const amendmentsRouter: Router = Router();

const create = { body: createAmendmentBody };
amendmentsRouter.post('/', requirePermission('gst:manage'), validate(create), async (req, res) => {
  const { body } = validated<typeof create>(req);
  res.status(201).json({ data: await amendments.createAmendment(body) });
});

const list = { query: listAmendmentsQuery };
amendmentsRouter.get('/', requirePermission('gst:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json({ data: await amendments.listAmendments(query) });
});

const byId = { params: idParams };
amendmentsRouter.post('/:id/withdraw', requirePermission('gst:manage'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await amendments.withdrawAmendment(params.id) });
});
