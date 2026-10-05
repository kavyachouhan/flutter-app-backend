import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as printService from './print.service.js';
import {
  createCustomFieldBody,
  listCustomFieldsQuery,
  printProfileParams,
  updateCustomFieldBody,
  upsertPrintProfileBody,
} from './print.schemas.js';

export const printProfilesRouter: Router = Router();
export const customFieldsRouter: Router = Router();

// --- Print profiles --------------------------------------------------------

printProfilesRouter.get('/', requirePermission('tenant:read'), async (_req, res) => {
  res.json({ data: await printService.listPrintProfiles() });
});

const upsert = { params: printProfileParams, body: upsertPrintProfileBody };
printProfilesRouter.put(
  '/:outletId',
  requirePermission('tenant:manage'),
  validate(upsert),
  async (req, res) => {
    const { params, body } = validated<typeof upsert>(req);
    const outletId = params.outletId === 'default' ? null : params.outletId;
    res.json({ data: await printService.upsertPrintProfile(outletId, body) });
  },
);

// --- Custom field definitions ---------------------------------------------

const listFields = { query: listCustomFieldsQuery };
customFieldsRouter.get(
  '/',
  requirePermission('tenant:read'),
  validate(listFields),
  async (req, res) => {
    const { query } = validated<typeof listFields>(req);
    res.json({ data: await printService.listCustomFields(query.includeInactive ?? false) });
  },
);

const createField = { body: createCustomFieldBody };
customFieldsRouter.post(
  '/',
  requirePermission('tenant:manage'),
  validate(createField),
  async (req, res) => {
    const { body } = validated<typeof createField>(req);
    res.status(201).json({ data: await printService.createCustomField(body) });
  },
);

const updateField = { params: idParams, body: updateCustomFieldBody };
customFieldsRouter.patch(
  '/:id',
  requirePermission('tenant:manage'),
  validate(updateField),
  async (req, res) => {
    const { params, body } = validated<typeof updateField>(req);
    res.json({ data: await printService.updateCustomField(params.id, body) });
  },
);

const byId = { params: idParams };
customFieldsRouter.delete(
  '/:id',
  requirePermission('tenant:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await printService.deleteCustomField(params.id);
    res.status(204).end();
  },
);
