import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { buildFinancialCreditNotePayload, buildSalesDebitNotePayload } from '../print/print.service.js';
import { printPayloadQuery } from '../print/print.schemas.js';
import * as service from './adjustment-notes.service.js';
import {
  createFinancialCreditNoteBody,
  createSalesDebitNoteBody,
  listNotesQuery,
  voidNoteBody,
} from './adjustment-notes.schemas.js';

const list = { query: listNotesQuery };
const byId = { params: idParams };
const voidNote = { params: idParams, body: voidNoteBody };

export const salesDebitNotesRouter: Router = Router();

salesDebitNotesRouter.get('/', requirePermission('credit_notes:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await service.listSalesDebitNotes(query));
});

salesDebitNotesRouter.get('/:id', requirePermission('credit_notes:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await service.getSalesDebitNote(params.id) });
});

const printDebit = { params: idParams, query: printPayloadQuery };
salesDebitNotesRouter.get('/:id/print-payload', requirePermission('credit_notes:read'), validate(printDebit), async (req, res) => {
  const { params, query } = validated<typeof printDebit>(req);
  res.json({ data: await buildSalesDebitNotePayload(params.id, query) });
});

const createDebit = { body: createSalesDebitNoteBody };
salesDebitNotesRouter.post('/', requirePermission('credit_notes:create'), validate(createDebit), async (req, res) => {
  const { body } = validated<typeof createDebit>(req);
  const { debitNote, replayed } = await service.createSalesDebitNote(body);
  res.status(replayed ? 200 : 201).json({ data: debitNote, replayed });
});

salesDebitNotesRouter.post('/:id/void', requirePermission('credit_notes:void'), validate(voidNote), async (req, res) => {
  const { params, body } = validated<typeof voidNote>(req);
  res.json({ data: await service.voidSalesDebitNote(params.id, body.reason) });
});

export const financialCreditNotesRouter: Router = Router();

financialCreditNotesRouter.get('/', requirePermission('credit_notes:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await service.listFinancialCreditNotes(query));
});

financialCreditNotesRouter.get('/:id', requirePermission('credit_notes:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await service.getFinancialCreditNote(params.id) });
});

financialCreditNotesRouter.get('/:id/print-payload', requirePermission('credit_notes:read'), validate(printDebit), async (req, res) => {
  const { params, query } = validated<typeof printDebit>(req);
  res.json({ data: await buildFinancialCreditNotePayload(params.id, query) });
});

const createFinancial = { body: createFinancialCreditNoteBody };
financialCreditNotesRouter.post('/', requirePermission('credit_notes:create'), validate(createFinancial), async (req, res) => {
  const { body } = validated<typeof createFinancial>(req);
  const { creditNote, replayed } = await service.createFinancialCreditNote(body);
  res.status(replayed ? 200 : 201).json({ data: creditNote, replayed });
});

financialCreditNotesRouter.post('/:id/void', requirePermission('credit_notes:void'), validate(voidNote), async (req, res) => {
  const { params, body } = validated<typeof voidNote>(req);
  res.json({ data: await service.voidFinancialCreditNote(params.id, body.reason) });
});
