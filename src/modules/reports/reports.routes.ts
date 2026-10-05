import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { csvFilename, reportToCsv } from './reports.csv.js';
import { reportIdParams, reportParamsQuery } from './reports.filters.js';
import * as reportsService from './reports.service.js';

export const reportsRouter: Router = Router();

/** The catalogue, with a `locked` flag so the client can show an upsell. */
reportsRouter.get('/', requirePermission('reports:read'), async (_req, res) => {
  res.json({ data: await reportsService.listReports() });
});

const run = {
  params: reportIdParams,
  query: reportParamsQuery.extend({ format: z.enum(['json', 'csv']).optional() }),
};
reportsRouter.get(
  '/:reportId',
  requirePermission('reports:read'),
  validate(run),
  async (req, res) => {
    const { params, query } = validated<typeof run>(req);
    const result = await reportsService.runReport(params.reportId, query);

    // Served inline rather than uploaded to storage and signed, unlike the
    // spreadsheet exporter: a report is already bounded to REPORT_MAX_ROWS, so
    // the response is small and a round trip through object storage would buy
    // nothing but latency and a URL to clean up.
    if (query.format === 'csv') {
      res
        .status(200)
        .type('text/csv; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="${csvFilename(result)}"`)
        .send(reportToCsv(result));
      return;
    }
    res.json({ data: result });
  },
);
