/**
 * The report kernel: one path from a report id to a rendered result.
 *
 * Everything that must not vary between reports happens here — the outlet
 * boundary, the range limit, the row cap, the plan gate and the totals row.
 * A report definition only says what to select.
 */
import { withReadTransaction } from '../../db/tx.js';
import { NotFoundError, ForbiddenError, ErrorCode, ValidationError } from '../../lib/errors.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { requireAuthContext } from '../../lib/context.js';
import { hasPermission } from '../auth/permissions.js';
import {
  assertFeature,
  getSubscriptionWithUsage,
  hasFeature,
} from '../entitlements/entitlements.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { REPORTS, findReport } from './reports.registry.js';
import { resolveReportParams, type ReportParamsQuery } from './reports.filters.js';
import type { ReportDefinition, ReportResult, ReportRow } from './reports.types.js';

function businessDateIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export interface ReportCatalogueEntry {
  id: string;
  title: string;
  description: string;
  group: string;
  filters: readonly string[];
  /**
   * True when the plan does not include it. The client renders an upsell
   * instead of discovering a 402 after the user has picked a date range.
   */
  locked: boolean;
  /** True when the member's role cannot run it, whatever the plan says. */
  restricted: boolean;
}

export function listReports(): Promise<ReportCatalogueEntry[]> {
  const auth = requireAuthContext();

  return withReadTransaction(async (tx) => {
    const subscription = await getSubscriptionWithUsage(tx);
    return REPORTS.map((report) => ({
      id: report.id,
      title: report.title,
      description: report.description,
      group: report.group,
      filters: report.filters,
      locked: report.feature !== undefined && !hasFeature(subscription.features, report.feature),
      restricted: report.permission !== undefined && !hasPermission(auth.role, report.permission),
    }));
  });
}

export function runReport(reportId: string, query: ReportParamsQuery): Promise<ReportResult> {
  const auth = requireAuthContext();

  const report = findReport(reportId);
  if (!report) throw new NotFoundError('Report');

  if (report.permission && !hasPermission(auth.role, report.permission)) {
    throw new ForbiddenError(undefined, ErrorCode.INSUFFICIENT_ROLE, {
      details: { required: report.permission },
    });
  }
  if (query.outletId) assertOutletAccess(query.outletId);

  // A statement is about one person; without a customer it would be every
  // customer's ledger interleaved, which is not a document anyone wants.
  if (
    report.filters.includes('customerId') &&
    report.id === 'khata-statement' &&
    !query.customerId
  ) {
    throw new ValidationError('A khata statement needs a customer.', {
      details: { fields: { customerId: 'required' } },
    });
  }

  return withReadTransaction(async (tx) => {
    // Each definition names its own gate, so adding a report to a tier is a
    // one-line change where the report is declared.
    if (report.feature) await assertFeature(tx, report.feature);

    const settings = await tenantsRepository.getSettings(tx);
    const params = resolveReportParams(
      query,
      { outletIds: accessibleOutletIds(), outletId: query.outletId },
      settings.timezone,
      businessDateIn(settings.timezone, new Date()),
    );

    // One extra row tells the client the view was cut short, without a COUNT.
    const rows = await report.run(tx, { ...params, limit: params.limit + 1 });
    const truncated = rows.length > params.limit;
    const visible = truncated ? rows.slice(0, params.limit) : rows;

    return {
      reportId: report.id,
      title: report.title,
      columns: report.columns,
      rows: visible,
      totals: totalsFor(report, visible),
      truncated,
      generatedAt: new Date().toISOString(),
      params: { from: params.from, to: params.to, outletId: query.outletId },
    };
  });
}

/**
 * Totals are summed from the rows being shown, not recomputed in SQL, so the
 * footer always adds up to the figures above it — including when the view was
 * truncated.
 */
function totalsFor(report: ReportDefinition, rows: readonly ReportRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const column of report.columns) {
    if (!column.total) continue;
    let sum = 0;
    for (const row of rows) {
      const value = row[column.key];
      if (typeof value === 'number') sum += value;
      else if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) sum += parsed;
      }
    }
    totals[column.key] = sum;
  }
  return totals;
}
