/**
 * Assembles the OpenAPI 3.1 document from everything the modules registered.
 *
 * The imports below are for their side effects: each `<module>.openapi.ts`
 * registers its paths on import. A module missing from this list is missing
 * from the document, which `openapi.test.ts` catches by walking the live
 * Express router and diffing it against the generated paths.
 */
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { env } from '../config/env.js';
import { registry } from './registry.js';
import './common.js';
import '../modules/health/health.openapi.js';
import '../modules/auth/auth.openapi.js';
import '../modules/tenants/tenants.openapi.js';
import '../modules/members/members.openapi.js';
import '../modules/devices/devices.openapi.js';
import '../modules/outlets/outlets.openapi.js';
import '../modules/catalogue/catalogue.openapi.js';
import '../modules/customers/customers.openapi.js';
import '../modules/numbering/numbering.openapi.js';
import '../modules/invoices/invoices.openapi.js';
import '../modules/payments/payments.openapi.js';
import '../modules/credit-notes/credit-notes.openapi.js';
import '../modules/stock/stock.openapi.js';
import '../modules/operations/operations.openapi.js';
import '../modules/reports/reports.openapi.js';
import '../modules/audit/audit.openapi.js';
import '../modules/sync/sync.openapi.js';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

let cached: OpenApiDocument | undefined;

export function buildOpenApiDocument(): OpenApiDocument {
  cached ??= new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: env.OPENAPI_TITLE,
      version: env.version,
      description: [
        'GST billing and khata API for the Khata clients.',
        '',
        '**Conventions.** Money is integer paise; quantities are integer thousandths of a unit.',
        'Success responses are `{ data }` or `{ data, nextCursor }`; every error is',
        '`{ error: { code, message, details?, requestId } }` and clients branch on `code`.',
        'Clients generate the `id` of every document and master they create (UUID v4 or v7);',
        'creating with an id that already exists returns the existing record, which makes',
        'offline retries safe. A resource in another tenant answers 404, never 403.',
        '',
        '**Headers.** Send `X-Request-Id` to correlate logs; it is echoed back. Rate-limited',
        'responses carry `Retry-After`; every response carries `RateLimit-Remaining`.',
      ].join('\n'),
    },
    servers: [{ url: env.OPENAPI_SERVER_URL }],
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes, outside `/v1`.' },
      { name: 'Auth', description: 'Phone OTP sign-in, sessions and tokens.' },
      { name: 'Onboarding', description: 'Creating and choosing a business (identity token).' },
      { name: 'Tenant', description: 'The current business and its subscription.' },
      { name: 'Members', description: 'Staff and roles.' },
      { name: 'Devices', description: 'Registered devices and their outlet/counter binding.' },
      { name: 'Outlets', description: 'Outlets (branches) and counters (tills).' },
      { name: 'Catalogue', description: 'Categories, items and barcodes.' },
      { name: 'Customers', description: 'Customer master and khata ledger.' },
      { name: 'Numbering', description: 'Document series and device-leased number blocks.' },
      { name: 'Invoices', description: 'Issuing, voiding and listing invoices.' },
      { name: 'Payments', description: 'Receipts against the khata and their allocations.' },
      { name: 'Credit notes', description: 'Returns and corrections against issued invoices.' },
      { name: 'Stock', description: 'Balances, ledger and manual adjustments.' },
      {
        name: 'Operations',
        description: 'Parked bills, expenses and the day’s cash-up.',
      },
      {
        name: 'Reports',
        description: 'One catalogue and one envelope for every report.',
      },
      { name: 'Audit', description: 'Who changed what, when.' },
      { name: 'Sync', description: 'Offline-first change feed and operation push.' },
      { name: 'Development', description: 'Mounted only in development with the auth bypass.' },
    ],
  });
  return cached;
}

export const __testing = {
  reset(): void {
    cached = undefined;
  },
};
