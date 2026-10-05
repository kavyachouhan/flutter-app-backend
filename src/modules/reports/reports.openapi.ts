import { z } from 'zod';
import { errorResponses } from '../../openapi/common.js';
import {
  accessTokenSecurity,
  dataEnvelope,
  jsonResponse,
  registry,
  timestamp,
} from '../../openapi/registry.js';
import { reportIdParams, reportParamsQuery } from './reports.filters.js';
import { REPORTS } from './reports.registry.js';

const reportIds = REPORTS.map((r) => r.id) as [string, ...string[]];

export const reportIdSchema = registry.register('ReportId', z.enum(reportIds));

export const reportColumnSchema = registry.register(
  'ReportColumn',
  z.object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(['text', 'money', 'quantity', 'number', 'percent', 'date', 'datetime']).openapi({
      description:
        'Formatting rule. `money` is integer paise, `quantity` integer thousandths — the same scales as everywhere else.',
    }),
    total: z.boolean().optional(),
    secondary: z.boolean().optional().openapi({
      description: 'Hide on a narrow screen; show on a tablet and in exports.',
    }),
  }),
);

export const reportCatalogueEntrySchema = registry.register(
  'ReportCatalogueEntry',
  z.object({
    id: reportIdSchema,
    title: z.string(),
    description: z.string(),
    group: z.enum(['sales', 'inventory', 'money', 'customers', 'compliance']),
    filters: z.array(z.string()),
    locked: z.boolean().openapi({
      description: 'The plan does not include it. Render an upsell rather than running it.',
    }),
    restricted: z.boolean().openapi({
      description: 'The signed-in role may not run it, whatever the plan says.',
    }),
  }),
);

export const reportResultSchema = registry.register(
  'ReportResult',
  z.object({
    reportId: reportIdSchema,
    title: z.string(),
    columns: z.array(reportColumnSchema),
    rows: z.array(z.record(z.unknown())).openapi({
      description: 'Each row is keyed by `columns[].key`. Values follow the column kind.',
    }),
    totals: z.record(z.number()).openapi({
      description:
        'Sums of the columns marked `total`, computed over the rows returned — so the footer always adds up to what is shown, truncated or not.',
    }),
    truncated: z.boolean(),
    generatedAt: timestamp,
    params: z.object({
      from: z.string(),
      to: z.string().openapi({ description: 'Exclusive upper bound.' }),
      outletId: z.string().optional(),
    }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/reports',
  tags: ['Reports'],
  summary: 'The report catalogue',
  description:
    'Every report this build can run, with whether the plan and the role allow it. The client renders from this rather than hardcoding a list.',
  security: accessTokenSecurity,
  responses: {
    200: jsonResponse('Catalogue.', dataEnvelope(z.array(reportCatalogueEntrySchema))),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/reports/{reportId}',
  tags: ['Reports'],
  summary: 'Run a report',
  description: [
    'One envelope for every report: a column schema and rows keyed by it, so one widget renders',
    'all of them. Results are scoped to the outlets the member may see, and capped by row count',
    'and date range.',
    '',
    'Pass `format=csv` for the same report as a file. The conversion is generic — it reads the',
    'column `kind` and nothing else — so every report exports without its own code. Money and',
    'quantity columns are converted to rupees and units there, since a spreadsheet is read by a',
    'person rather than by a client that knows the scales.',
    '',
    'Not every report is in every plan, and some are withheld from a cashier whatever the plan',
    'says. `GET /v1/reports` reports both per report, so the client can show an upsell instead of',
    'discovering a 402 after the user has picked a date range.',
  ].join(String.fromCharCode(10)),
  security: accessTokenSecurity,
  request: {
    params: reportIdParams,
    query: reportParamsQuery.extend({ format: z.enum(['json', 'csv']).optional() }),
  },
  responses: {
    200: {
      description: 'Rendered report, as JSON or as a CSV attachment.',
      content: {
        'application/json': { schema: dataEnvelope(reportResultSchema) },
        'text/csv': { schema: z.string() },
      },
    },
    ...errorResponses(402),
  },
});
