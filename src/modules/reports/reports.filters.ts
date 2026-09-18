import { z } from 'zod';
import { env } from '../../config/env.js';
import { ValidationError } from '../../lib/errors.js';
import { isoDate, nonEmpty } from '../../lib/validators.js';
import { Params, type ReportParams, type ReportScope } from './reports.types.js';

export const reportParamsQuery = z.object({
  outletId: z.string().uuid().optional(),
  /** Inclusive calendar date. */
  from: isoDate.optional(),
  /** Inclusive calendar date; the kernel widens it to an exclusive bound. */
  to: isoDate.optional(),
  customerId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  mode: nonEmpty.optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export type ReportParamsQuery = z.infer<typeof reportParamsQuery>;

export const reportIdParams = z.object({ reportId: nonEmpty });

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * Resolves the query into the bounded, outlet-scoped parameters every report
 * runs against.
 *
 * The date window is half-open: `from` inclusive, `to` exclusive. A caller
 * passes an inclusive end date because that is what a person means by "to
 * 31 March", and the kernel is the single place that widens it — doing it per
 * report is how a day goes missing from one report and appears twice in another.
 */
export function resolveReportParams(
  query: ReportParamsQuery,
  scope: ReportScope,
  timezone: string,
  today: string,
): ReportParams {
  const from = query.from ?? today;
  const toInclusive = query.to ?? from;
  if (toInclusive < from) {
    throw new ValidationError('The end of the range is before its start.', {
      details: { from, to: toInclusive },
    });
  }
  const span = daysBetween(from, toInclusive) + 1;
  if (span > env.REPORT_MAX_RANGE_DAYS) {
    throw new ValidationError(
      `A report covers at most ${env.REPORT_MAX_RANGE_DAYS} days; this range is ${span}.`,
      { details: { maxDays: env.REPORT_MAX_RANGE_DAYS, requested: span } },
    );
  }

  return {
    scope,
    from,
    to: addDays(toInclusive, 1),
    customerId: query.customerId,
    categoryId: query.categoryId,
    itemId: query.itemId,
    mode: query.mode,
    limit: Math.min(query.limit ?? env.REPORT_MAX_ROWS, env.REPORT_MAX_ROWS),
    timezone,
  };
}

/**
 * The outlet boundary, in one place.
 *
 * Outlet scoping is a security control, not a filter: a branch manager must
 * never see another branch's takings. Forty hand-written copies would be forty
 * chances to leave one out, so every report calls this and no report writes
 * its own outlet predicate.
 */
export function outletScope(p: Params, alias: string, params: ReportParams): string {
  const permitted = p.add(params.scope.outletIds === null ? null : [...params.scope.outletIds]);
  const requested = p.add(params.scope.outletId ?? null);
  return `(${permitted}::uuid[] IS NULL OR ${alias}.outlet_id = ANY(${permitted}::uuid[]))
      AND (${requested}::uuid IS NULL OR ${alias}.outlet_id = ${requested}::uuid)`;
}

/** A half-open window on a `timestamptz` column, in the shop's own day. */
export function instantRange(p: Params, column: string, params: ReportParams): string {
  const from = p.add(params.from);
  const to = p.add(params.to);
  const tz = p.add(params.timezone);
  return `${column} >= (${from}::date::timestamp AT TIME ZONE ${tz})
      AND ${column} < (${to}::date::timestamp AT TIME ZONE ${tz})`;
}

/** A half-open window on a `date` column, which carries no timezone. */
export function dateRange(p: Params, column: string, params: ReportParams): string {
  const from = p.add(params.from);
  const to = p.add(params.to);
  return `${column} >= ${from}::date AND ${column} < ${to}::date`;
}

/** The shop's local calendar day for a `timestamptz`, for grouping. */
export function businessDay(p: Params, column: string, params: ReportParams): string {
  return `(${column} AT TIME ZONE ${p.add(params.timezone)})::date`;
}
