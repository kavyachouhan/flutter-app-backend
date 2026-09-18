import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as service from './credit-notes.service.js';
import {
  createCreditNoteBody,
  listCreditNotesQuery,
  voidCreditNoteBody,
} from './credit-notes.schemas.js';

export const creditNotesRouter: Router = Router();

const list = { query: listCreditNotesQuery };
creditNotesRouter.get(
  '/',
  requirePermission('credit_notes:read'),
  validate(list),
  async (req, res) => {
    const { query } = validated<typeof list>(req);
    res.json(await service.listCreditNotes(query));
  },
);

const byId = { params: idParams };
creditNotesRouter.get(
  '/:id',
  requirePermission('credit_notes:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.getCreditNote(params.id) });
  },
);

const create = { body: createCreditNoteBody };
creditNotesRouter.post(
  '/',
  requirePermission('credit_notes:create'),
  validate(create),
  async (req, res) => {
    const { body } = validated<typeof create>(req);
    const { creditNote, replayed } = await service.createCreditNote(body);
    res.status(replayed ? 200 : 201).json({ data: creditNote, replayed });
  },
);

const voidSchemas = { params: idParams, body: voidCreditNoteBody };
creditNotesRouter.post(
  '/:id/void',
  requirePermission('credit_notes:void'),
  validate(voidSchemas),
  async (req, res) => {
    const { params, body } = validated<typeof voidSchemas>(req);
    res.json({ data: await service.voidCreditNote(params.id, body.reason) });
  },
);

creditNotesRouter.post(
  '/:id/printed',
  requirePermission('credit_notes:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.markPrinted(params.id) });
  },
);
