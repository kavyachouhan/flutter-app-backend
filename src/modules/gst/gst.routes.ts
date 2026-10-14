import { Router } from 'express';
import { z } from 'zod';
import { pageQuery } from '../../lib/pagination.js';
import { signDownload } from '../../lib/storage.js';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as exportService from './export.service.js';
import * as reconciliation from './reconciliation.service.js';
import * as service from './gst.service.js';
import {
  acceptMatchBody,
  createGstr2bImportBody,
  createPeriodBody,
  filePeriodBody,
  itcRegisterQuery,
  listMatchesQuery,
  listPeriodsQuery,
} from './gst.schemas.js';

export const gstRouter: Router = Router();

// --- Return periods --------------------------------------------------------

const listPeriods = { query: listPeriodsQuery };
gstRouter.get('/periods', requirePermission('gst:read'), validate(listPeriods), async (req, res) => {
  const { query } = validated<typeof listPeriods>(req);
  res.json(await service.listPeriods(query));
});

const createPeriod = { body: createPeriodBody };
gstRouter.post(
  '/periods',
  requirePermission('gst:manage'),
  validate(createPeriod),
  async (req, res) => {
    const { body } = validated<typeof createPeriod>(req);
    res.status(201).json({ data: await service.createPeriod(body) });
  },
);

const byId = { params: idParams };
gstRouter.get('/periods/:id', requirePermission('gst:read'), validate(byId), async (req, res) => {
  const { params } = validated<typeof byId>(req);
  res.json({ data: await service.getPeriod(params.id) });
});

gstRouter.post(
  '/periods/:id/prepare',
  requirePermission('gst:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await service.preparePeriod(params.id) });
  },
);

const filePeriod = { params: idParams, body: filePeriodBody };
gstRouter.post(
  '/periods/:id/file',
  requirePermission('gst:manage'),
  validate(filePeriod),
  async (req, res) => {
    const { params, body } = validated<typeof filePeriod>(req);
    res.json({ data: await service.filePeriod(params.id, body) });
  },
);

const exportPeriod = {
  params: idParams,
  query: z.object({ format: z.enum(['xlsx', 'json']).default('xlsx') }),
};
gstRouter.get(
  '/periods/:id/export',
  requirePermission('gst:read'),
  validate(exportPeriod),
  async (req, res) => {
    const { params, query } = validated<typeof exportPeriod>(req);
    const result = await exportService.exportPeriod(params.id, query.format);
    // Signed here rather than in the service, so the service stays testable
    // without a storage round trip — as with the spreadsheet exporter.
    const link = await signDownload(result.objectKey, result.filename);
    res.json({ data: { ...result, downloadUrl: link.url, expiresAt: link.expiresAt } });
  },
);

// --- ITC register ----------------------------------------------------------

const itcRegister = { query: itcRegisterQuery };
gstRouter.get(
  '/itc-register',
  requirePermission('gst:read'),
  validate(itcRegister),
  async (req, res) => {
    const { query } = validated<typeof itcRegister>(req);
    res.json(await service.listItcRegister(query));
  },
);

// --- GSTR-2B reconciliation ------------------------------------------------

const listImports = { query: pageQuery };
gstRouter.get(
  '/2b-imports',
  requirePermission('gst:read'),
  validate(listImports),
  async (req, res) => {
    const { query } = validated<typeof listImports>(req);
    res.json(await reconciliation.listImports(query));
  },
);

const createImport = { body: createGstr2bImportBody };
gstRouter.post(
  '/2b-imports',
  requirePermission('gst:manage'),
  validate(createImport),
  async (req, res) => {
    const { body } = validated<typeof createImport>(req);
    res.status(201).json({ data: await reconciliation.createImport(body) });
  },
);

gstRouter.get(
  '/2b-imports/:id',
  requirePermission('gst:read'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await reconciliation.getImport(params.id) });
  },
);

gstRouter.post(
  '/2b-imports/:id/ingest',
  requirePermission('gst:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await reconciliation.ingestImport(params.id) });
  },
);

gstRouter.post(
  '/2b-imports/:id/reconcile',
  requirePermission('gst:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    res.json({ data: await reconciliation.reconcileImport(params.id) });
  },
);

const matches = { params: idParams, query: listMatchesQuery };
gstRouter.get(
  '/2b-imports/:id/matches',
  requirePermission('gst:read'),
  validate(matches),
  async (req, res) => {
    const { params, query } = validated<typeof matches>(req);
    res.json(await reconciliation.listMatches(params.id, query));
  },
);

const accept = {
  params: z.object({ id: z.string().uuid(), matchId: z.string().uuid() }),
  body: acceptMatchBody,
};
gstRouter.post(
  '/2b-imports/:id/matches/:matchId/accept',
  requirePermission('gst:manage'),
  validate(accept),
  async (req, res) => {
    const { params, body } = validated<typeof accept>(req);
    res.json({ data: await reconciliation.acceptMatch(params.id, params.matchId, body) });
  },
);
