import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { reportIdParams, reportParamsQuery } from './reports.filters.js';
import * as reportsService from './reports.service.js';

export const reportsRouter: Router = Router();

/** The catalogue, with a `locked` flag so the client can show an upsell. */
reportsRouter.get('/', requirePermission('reports:read'), async (_req, res) => {
  res.json({ data: await reportsService.listReports() });
});

const run = { params: reportIdParams, query: reportParamsQuery };
reportsRouter.get(
  '/:reportId',
  requirePermission('reports:read'),
  validate(run),
  async (req, res) => {
    const { params, query } = validated<typeof run>(req);
    res.json({ data: await reportsService.runReport(params.reportId, query) });
  },
);
