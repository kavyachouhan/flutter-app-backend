import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as invoicesService from './invoices.service.js';
import { listReturnable } from '../credit-notes/credit-notes.service.js';
import { createInvoiceBody, listInvoicesQuery, voidInvoiceBody } from './invoices.schemas.js';

export const invoicesRouter: Router = Router();

const list = { query: listInvoicesQuery };
invoicesRouter.get('/', requirePermission('invoices:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await invoicesService.listInvoices(query));
});

const byId = { params: idParams };
invoicesRouter.get('/:id', requirePermission('invoices:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await invoicesService.getInvoice(params.id) });
});

// 200 on a replayed upload so a client can tell a retry from a first write.
const create = { body: createInvoiceBody };
invoicesRouter.post(
  '/',
  requirePermission('invoices:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    const { invoice, warnings, replayed } = await invoicesService.createInvoice(body);
    res.status(replayed ? 200 : 201).json({ data: invoice, warnings, replayed });
  },
);

const voidSchemas = { params: idParams, body: voidInvoiceBody };
invoicesRouter.post(
  '/:id/void',
  requirePermission('invoices:void'),
  validate(voidSchemas),
  async (req, res) => {
    const { params, body } = validated<typeof voidSchemas>(req);
    res.json({ data: await invoicesService.voidInvoice(params.id, body.reason) });
  },
);

invoicesRouter.get(
  '/:id/returnable',
  requirePermission('credit_notes:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await listReturnable(params.id) });
  },
);

invoicesRouter.post(
  '/:id/printed',
  requirePermission('invoices:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await invoicesService.markPrinted(params.id) });
  },
);
