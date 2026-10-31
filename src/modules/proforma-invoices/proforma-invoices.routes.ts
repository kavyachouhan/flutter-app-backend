import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { buildProformaInvoicePayload } from '../print/print.service.js';
import { printPayloadQuery } from '../print/print.schemas.js';
import * as proformaInvoices from './proforma-invoices.service.js';
import {
  cancelProformaInvoiceBody,
  createProformaInvoiceBody,
  listProformaInvoicesQuery,
  summaryProformaInvoicesQuery,
  updateProformaInvoiceBody,
} from './proforma-invoices.schemas.js';

export const proformaInvoicesRouter: Router = Router();

const summary = { query: summaryProformaInvoicesQuery };
proformaInvoicesRouter.get(
  '/summary',
  requirePermission('proforma_invoices:read'),
  validate(summary),
  async (req, res) => {
    const { query } = validated<typeof summary>(req);
    res.json({ data: await proformaInvoices.summaryProformaInvoices(query) });
  },
);

const list = { query: listProformaInvoicesQuery };
proformaInvoicesRouter.get('/', requirePermission('proforma_invoices:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await proformaInvoices.listProformaInvoices(query));
});

// 200 on a replay so a client can tell a retry from a first write, as with orders.
const create = { body: createProformaInvoiceBody };
proformaInvoicesRouter.post(
  '/',
  requirePermission('proforma_invoices:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    const { proformaInvoice, replayed } = await proformaInvoices.createProformaInvoice(body);
    res.status(replayed ? 200 : 201).json({ data: proformaInvoice, replayed });
  },
);

const byId = { params: idParams };
proformaInvoicesRouter.get(
  '/:id',
  requirePermission('proforma_invoices:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await proformaInvoices.getProformaInvoice(params.id) });
  },
);

// The whole proforma invoice, formatted and ready to print or share.
const printPayload = { params: idParams, query: printPayloadQuery };
proformaInvoicesRouter.get(
  '/:id/print-payload',
  requirePermission('proforma_invoices:read'),
  validate(printPayload),
  async (req, res) => {
    const { params, query } = validated<typeof printPayload>(req);
    res.json({ data: await buildProformaInvoicePayload(params.id, query) });
  },
);

const update = { params: idParams, body: updateProformaInvoiceBody };
proformaInvoicesRouter.put(
  '/:id',
  requirePermission('proforma_invoices:update'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    const { proformaInvoice } = await proformaInvoices.updateProformaInvoice(params.id, body);
    res.json({ data: proformaInvoice });
  },
);

const remove = { params: idParams };
proformaInvoicesRouter.delete(
  '/:id',
  requirePermission('proforma_invoices:delete'),
  validate(remove),
  async (req, res) => {
    const { params } = validated<typeof remove>(req);
    await proformaInvoices.deleteProformaInvoice(params.id);
    res.status(204).end();
  },
);

const cancel = { params: idParams, body: cancelProformaInvoiceBody };
proformaInvoicesRouter.post(
  '/:id/cancel',
  requirePermission('proforma_invoices:update'),
  validate(cancel),
  async (req, res) => {
    const { params, body } = validated<typeof cancel>(req);
    res.json({ data: await proformaInvoices.cancelProformaInvoice(params.id, body) });
  },
);

proformaInvoicesRouter.post(
  '/:id/close',
  requirePermission('proforma_invoices:update'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await proformaInvoices.closeProformaInvoice(params.id) });
  },
);
