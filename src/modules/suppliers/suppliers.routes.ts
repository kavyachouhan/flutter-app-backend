import { Router } from 'express';
import { z } from 'zod';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as service from './suppliers.service.js';
import {
  createSupplierBody,
  listSuppliersQuery,
  supplierStatementQuery,
  updateSupplierBody,
} from './suppliers.schemas.js';

export const suppliersRouter: Router = Router();

const list = { query: listSuppliersQuery };
suppliersRouter.get('/', requirePermission('suppliers:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await service.listSuppliers(query));
});

// Registered before /:id so the literal path wins, as with /items/by-barcode.
const ageing = { query: z.object({ supplierId: z.string().uuid().optional() }) };
suppliersRouter.get(
  '/ageing',
  requirePermission('reports:financial'),
  validate(ageing),
  async (req, res) => {
    const { query } = validated<typeof ageing>(req);
    res.json({ data: await service.getAgeing(query.supplierId) });
  },
);

const create = { body: createSupplierBody };
suppliersRouter.post(
  '/',
  requirePermission('suppliers:write'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    res.status(201).json({ data: await service.createSupplier(body) });
  },
);

const byId = { params: idParams };
suppliersRouter.get(
  '/:id',
  requirePermission('suppliers:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.getSupplier(params.id) });
  },
);

const update = { params: idParams, body: updateSupplierBody };
suppliersRouter.patch(
  '/:id',
  requirePermission('suppliers:write'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    res.json({ data: await service.updateSupplier(params.id, body) });
  },
);

suppliersRouter.delete(
  '/:id',
  requirePermission('suppliers:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await service.deleteSupplier(params.id);
    res.status(204).end();
  },
);

const statement = { params: idParams, query: supplierStatementQuery };
suppliersRouter.get(
  '/:id/statement',
  requirePermission('suppliers:read'),
  validate(statement),
  async (req, res) => {
    const { params, query } = validated<typeof statement>(req);
    res.json(await service.getSupplierStatement(params.id, query));
  },
);

suppliersRouter.get(
  '/:id/outstanding-bills',
  requirePermission('purchases:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.getOutstandingBills(params.id) });
  },
);
