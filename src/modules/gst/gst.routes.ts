import { Router } from 'express';
import { z } from 'zod';
import { pageQuery } from '../../lib/pagination.js';
import { signDownload } from '../../lib/storage.js';
import { idParams } from '../../lib/validators.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import * as exportService from './export.service.js';
import { importLedgerBody, listLedgerImportsQuery } from './ledgers/ledger.schemas.js';
import * as ledgers from './ledgers/ledger.service.js';
import { hsnSalesQuery, sacQuery, transactionReportQuery } from './reports/gst-reports.schemas.js';
import { exportTransactionReport, hsnSalesReport, sacReport } from './reports/gst-reports.service.js';
import * as reconciliation from './reconciliation.service.js';
import * as service from './gst.service.js';
import * as registrations from './registrations.service.js';
import * as ruleSets from './rule-sets.service.js';
import {
  acceptMatchBody,
  createGstr2bImportBody,
  createPeriodBody,
  filePeriodBody,
  itcRegisterQuery,
  listMatchesQuery,
  listPeriodsQuery,
  preparePeriodBody,
} from './gst.schemas.js';

export const gstRouter: Router = Router();

// --- Rule sets and the HSN/SAC master ----------------------------------------

// Every device bills with these, so any signed-in member may read them.
export const updateRegistrationBody = z.object({ roundOffEnabled: z.boolean() });

const ruleSetsQuery = {
  query: z.object({ since: z.string().datetime({ offset: true }).optional() }),
};
gstRouter.get('/rule-sets', validate(ruleSetsQuery), async (req, res) => {
  const { query } = validated<typeof ruleSetsQuery>(req);
  res.json({ data: await ruleSets.listRuleSets(query.since) });
});

const hsnQuery = { query: z.object({ version: z.string().max(64).optional() }) };
gstRouter.get('/hsn-master', validate(hsnQuery), async (req, res) => {
  const { query } = validated<typeof hsnQuery>(req);
  res.json({ data: await ruleSets.hsnMaster(query.version) });
});

// --- Registrations -----------------------------------------------------------

gstRouter.get('/registrations', requirePermission('gst:read'), async (_req, res) => {
  res.json({ data: await registrations.listRegistrations() });
});

const updateRegistration = { params: idParams, body: updateRegistrationBody };
gstRouter.patch(
  '/registrations/:id',
  requirePermission('gst:manage'),
  validate(updateRegistration),
  async (req, res) => {
    const { params, body } = validated<typeof updateRegistration>(req);
    res.json({ data: await registrations.updateRegistration(params.id, body) });
  },
);

// --- Return periods --------------------------------------------------------

const listPeriods = { query: listPeriodsQuery };
gstRouter.get(
  '/periods',
  requirePermission('gst:read'),
  validate(listPeriods),
  async (req, res) => {
    const { query } = validated<typeof listPeriods>(req);
    res.json(await service.listPeriods(query));
  },
);

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

const prepare = { params: idParams, body: preparePeriodBody };
gstRouter.post(
  '/periods/:id/prepare',
  requirePermission('gst:manage'),
  validate(prepare),
  async (req, res) => {
    const { params, body } = validated<typeof prepare>(req);
    res.json({ data: await service.preparePeriod(params.id, body) });
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
  query: z.object({
    format: z.enum(['xlsx', 'json', 'ca']).default('xlsx'),
    // JSON only: accept a file that leaves out sections no official schema covers yet.
    acceptUnsupported: z.enum(['true', 'false']).default('false'),
  }),
};
gstRouter.get(
  '/periods/:id/export',
  requirePermission('gst:read'),
  validate(exportPeriod),
  async (req, res) => {
    const { params, query } = validated<typeof exportPeriod>(req);
    const result = await exportService.exportPeriod(params.id, query.format, {
      acceptUnsupported: query.acceptUnsupported === 'true',
    });
    // Signed here rather than in the service, so the service stays testable
    // without a storage round trip — as with the spreadsheet exporter.
    const link = await signDownload(result.objectKey, result.filename);
    res.json({ data: { ...result, downloadUrl: link.url, expiresAt: link.expiresAt } });
  },
);

// --- Reports ---------------------------------------------------------------

const transactionReport = { query: transactionReportQuery };
gstRouter.get(
  '/reports/transactions',
  requirePermission('gst:read'),
  validate(transactionReport),
  async (req, res) => {
    const { query } = validated<typeof transactionReport>(req);
    const result = await exportTransactionReport(query);
    const link = await signDownload(result.objectKey, result.filename);
    res.json({ data: { ...result, downloadUrl: link.url, expiresAt: link.expiresAt } });
  },
);

/** A table report is either shown (json) or handed over as a signed workbook link. */
async function sendTableReport(
  res: import('express').Response,
  out: Awaited<ReturnType<typeof hsnSalesReport>>,
): Promise<void> {
  if (out.kind === 'json') {
    res.json({ data: out.report });
    return;
  }
  const link = await signDownload(out.objectKey, out.filename);
  res.json({
    data: {
      objectKey: out.objectKey,
      filename: out.filename,
      contentType: out.contentType,
      downloadUrl: link.url,
      expiresAt: link.expiresAt,
      issues: out.report.issues,
    },
  });
}

const hsnSales = { query: hsnSalesQuery };
gstRouter.get(
  '/reports/hsn-sales',
  requirePermission('gst:read'),
  validate(hsnSales),
  async (req, res) => {
    const { query } = validated<typeof hsnSales>(req);
    await sendTableReport(res, await hsnSalesReport(query));
  },
);

const sac = { query: sacQuery };
gstRouter.get('/reports/sac', requirePermission('gst:read'), validate(sac), async (req, res) => {
  const { query } = validated<typeof sac>(req);
  await sendTableReport(res, await sacReport(query));
});

// --- Electronic ledgers ------------------------------------------------------

const importLedger = { body: importLedgerBody };
gstRouter.post(
  '/ledger-imports',
  requirePermission('gst:manage'),
  validate(importLedger),
  async (req, res) => {
    const { body } = validated<typeof importLedger>(req);
    res.status(201).json({ data: await ledgers.importLedger(body) });
  },
);

const listLedgers = { query: listLedgerImportsQuery };
gstRouter.get(
  '/ledger-imports',
  requirePermission('gst:read'),
  validate(listLedgers),
  async (req, res) => {
    const { query } = validated<typeof listLedgers>(req);
    res.json({ data: await ledgers.listLedgerImports(query) });
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
