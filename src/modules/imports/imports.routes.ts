import { Router } from 'express';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as importsService from './imports.service.js';
import {
  analyseBody,
  createImportBody,
  listImportsQuery,
  listRowsQuery,
} from './imports.schemas.js';

export const importsRouter: Router = Router();

const list = { query: listImportsQuery };
importsRouter.get('/', requirePermission('imports:read'), validate(list), async (req, res) => {
  const { query } = validated<typeof list>(req);
  res.json(await importsService.listImports(query));
});

const create = { body: createImportBody };
importsRouter.post('/', requirePermission('imports:write'), validate(create), async (req, res) => {
  const { body } = validated<typeof create>(req);
  res.status(201).json({ data: await importsService.createImport(body) });
});

const byId = { params: idParams };
importsRouter.get('/:id', requirePermission('imports:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await importsService.getImport(params.id) });
});

const rows = { params: idParams, query: listRowsQuery };
importsRouter.get(
  '/:id/rows',
  requirePermission('imports:read'),
  validate(rows),
  async (req, res) => {
    const { params, query } = validated<typeof rows>(req);
    res.json(await importsService.listImportRows(params.id, query));
  },
);

importsRouter.post(
  '/:id/ingest',
  requirePermission('imports:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await importsService.ingestImport(params.id) });
  },
);

// Both chunk endpoints answer with the job's progress and are meant to be
// called in a loop until `done` is true. They are idempotent on their cursor,
// so a retry after a dropped response repeats no work.
const analyse = { params: idParams, body: analyseBody };
importsRouter.post(
  '/:id/analyse',
  requirePermission('imports:write'),
  validate(analyse),
  async (req, res) => {
    const { params, body } = validated<typeof analyse>(req);
    res.json({ data: await importsService.analyseImport(params.id, body) });
  },
);

importsRouter.post(
  '/:id/apply',
  requirePermission('imports:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await importsService.applyImport(params.id) });
  },
);

importsRouter.post(
  '/:id/cancel',
  requirePermission('imports:write'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await importsService.cancelImport(params.id);
    res.status(204).end();
  },
);
