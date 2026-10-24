import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as service from './terms.service.js';
import { createTermsBody, listTermsQuery, updateTermsBody } from './terms.schemas.js';

export const termsRouter: Router = Router();

const list = { query: listTermsQuery };
termsRouter.get('/', requirePermission('terms:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await service.listTerms(query));
});

const create = { body: createTermsBody };
termsRouter.post('/', requirePermission('terms:write'), validate(create), async (req, res) => {
  const { body } = validated<typeof create>(req);
  res.status(201).json({ data: await service.createTerms(body) });
});

const byId = { params: idParams };
termsRouter.get('/:id', requirePermission('terms:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await service.getTerms(params.id) });
});

const update = { params: idParams, body: updateTermsBody };
termsRouter.patch('/:id', requirePermission('terms:write'), validate(update), async (req, res) => {
  const { params, body } = validated<typeof update>(req);
  res.json({ data: await service.updateTerms(params.id, body) });
});

termsRouter.delete('/:id', requirePermission('terms:write'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  await service.deleteTerms(params.id);
  res.status(204).end();
});
