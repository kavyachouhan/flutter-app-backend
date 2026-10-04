import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as service from './debit-notes.service.js';
import {
  createDebitNoteBody,
  listDebitNotesQuery,
  voidDebitNoteBody,
} from './debit-notes.schemas.js';

export const debitNotesRouter: Router = Router();

const list = { query: listDebitNotesQuery };
debitNotesRouter.get(
  '/',
  requirePermission('debit_notes:read'),
  validate(list),
  async (req, res) => {
    const { query } = validated<typeof list>(req);
    res.json(await service.listDebitNotes(query));
  },
);

const create = { body: createDebitNoteBody };
debitNotesRouter.post(
  '/',
  requirePermission('debit_notes:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    const { note, replayed } = await service.createDebitNote(body);
    res.status(replayed ? 200 : 201).json({ data: note, replayed });
  },
);

const byId = { params: idParams };
debitNotesRouter.get(
  '/:id',
  requirePermission('debit_notes:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.getDebitNote(params.id) });
  },
);

const voidSchemas = { params: idParams, body: voidDebitNoteBody };
debitNotesRouter.post(
  '/:id/void',
  requirePermission('debit_notes:void'),
  validate(voidSchemas),
  async (req, res) => {
    const { params, body } = validated<typeof voidSchemas>(req);
    res.json({ data: await service.voidDebitNote(params.id, body.reason) });
  },
);
