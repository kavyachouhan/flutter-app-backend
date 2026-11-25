import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../../middleware/authorize.js';
import { validate, validated } from '../../../middleware/validate.js';
import * as itc from './itc.service.js';
import {
  declareStatementBalanceBody,
  imsExportQuery,
  issueRcmSelfInvoiceBody,
  listRcmSelfInvoicesQuery,
  recordImsActionsBody,
  statementBalancesQuery,
} from './itc.schemas.js';

/** Mounted at /v1/gst/itc. */
export const itcRouter: Router = Router();

const issueSi = { body: issueRcmSelfInvoiceBody };
itcRouter.post('/rcm-self-invoices', requirePermission('gst:manage'), validate(issueSi), async (req, res) => {
  const { body } = validated<typeof issueSi>(req);
  const result = await itc.issueRcmSelfInvoice(body);
  res.status(result.replayed ? 200 : 201).json({
    data: result.invoice,
    lateUnderRule47A: result.lateUnderRule47A,
    replayed: result.replayed,
  });
});

const listSi = { query: listRcmSelfInvoicesQuery };
itcRouter.get('/rcm-self-invoices', requirePermission('gst:read'), validate(listSi), async (req, res) => {
  const { query } = validated<typeof listSi>(req);
  res.json({ data: await itc.listRcmSelfInvoices(query) });
});

const ims = { body: recordImsActionsBody };
itcRouter.post('/ims-actions', requirePermission('gst:manage'), validate(ims), async (req, res) => {
  const { body } = validated<typeof ims>(req);
  res.status(201).json({ data: await itc.recordImsActions(body) });
});

const imsExport = { query: imsExportQuery };
itcRouter.get('/ims-actions/export', requirePermission('gst:read'), validate(imsExport), async (req, res) => {
  const { query } = validated<typeof imsExport>(req);
  res.json({ data: await itc.exportImsJson(query.gstin) });
});

const declare = { body: declareStatementBalanceBody };
itcRouter.post('/statement-balances', requirePermission('gst:manage'), validate(declare), async (req, res) => {
  const { body } = validated<typeof declare>(req);
  res.status(201).json({ data: await itc.declareStatementBalance(body) });
});

const balances = { query: statementBalancesQuery };
itcRouter.get('/statement-balances', requirePermission('gst:read'), validate(balances), async (req, res) => {
  const { query } = validated<typeof balances>(req);
  res.json({ data: await itc.listStatementBalances(query.gstin) });
});

const history = { params: z.object({ registerId: z.string().uuid() }) };
itcRouter.get('/register/:registerId/movements', requirePermission('gst:read'), validate(history), async (req, res) => {
  const { params } = validated<typeof history>(req);
  res.json({ data: await itc.itcHistory(params.registerId) });
});
