import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export interface GstReturnPeriodRow {
  id: string;
  gstin: string;
  returnType: 'gstr1' | 'gstr3b' | 'gstr9';
  periodYear: number;
  periodMonth: number;
  periodFrom: string;
  periodTo: string;
  status: 'open' | 'prepared' | 'filed';
  workings: Record<string, unknown> | null;
  totalTaxable: number | null;
  totalTax: number | null;
  preparedAt: Date | null;
  preparedBy: string | null;
  filedAt: Date | null;
  filedBy: string | null;
  arn: string | null;
  notes: string | null;
  createdAt: Date;
}

const PERIOD_COLUMNS = `
  id, gstin, return_type AS "returnType", period_year AS "periodYear",
  period_month AS "periodMonth", period_from AS "periodFrom", period_to AS "periodTo",
  status, workings, total_taxable AS "totalTaxable", total_tax AS "totalTax",
  prepared_at AS "preparedAt", prepared_by AS "preparedBy", filed_at AS "filedAt",
  filed_by AS "filedBy", arn, notes, created_at AS "createdAt"`;

// The list is a table of rows; a prepared return's workings now hold every sheet, so they are left
// out here and read only when one period is opened.
const LIST_COLUMNS = PERIOD_COLUMNS.replace(
  'status, workings,',
  'status, NULL::jsonb AS workings,',
);

export const gstRepository = {
  findPeriod(tx: Tx, id: string, forUpdate = false): Promise<GstReturnPeriodRow | undefined> {
    return tx.one<GstReturnPeriodRow>(
      `SELECT ${PERIOD_COLUMNS} FROM gst_return_periods WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
  },

  findPeriodByScope(
    tx: Tx,
    scope: { gstin: string; returnType: string; periodYear: number; periodMonth: number },
  ): Promise<GstReturnPeriodRow | undefined> {
    return tx.one<GstReturnPeriodRow>(
      `SELECT ${PERIOD_COLUMNS} FROM gst_return_periods
       WHERE gstin = $1 AND return_type = $2 AND period_year = $3 AND period_month = $4`,
      [scope.gstin, scope.returnType, scope.periodYear, scope.periodMonth],
    );
  },

  listPeriods(
    tx: Tx,
    filter: {
      gstin: string | undefined;
      returnType: string | undefined;
      status: string | undefined;
    },
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<GstReturnPeriodRow[]> {
    return tx.many<GstReturnPeriodRow>(
      `SELECT ${LIST_COLUMNS} FROM gst_return_periods
       WHERE ($1::text IS NULL OR gstin = $1)
         AND ($2::text IS NULL OR return_type = $2)
         AND ($3::text IS NULL OR status = $3)
         AND ($4::text IS NULL OR (period_year * 100 + period_month, id)
                                  < (($4::int), $5::uuid))
       ORDER BY period_year DESC, period_month DESC, id DESC
       LIMIT $6`,
      [
        filter.gstin ?? null,
        filter.returnType ?? null,
        filter.status ?? null,
        cursor?.k ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async insertPeriod(
    tx: Tx,
    period: {
      id: string;
      gstin: string;
      returnType: string;
      periodYear: number;
      periodMonth: number;
      periodFrom: string;
      periodTo: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO gst_return_periods (id, tenant_id, gstin, return_type, period_year,
         period_month, period_from, period_to, status)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, 'open')`,
      [
        period.id,
        period.gstin,
        period.returnType,
        period.periodYear,
        period.periodMonth,
        period.periodFrom,
        period.periodTo,
      ],
    );
  },

  async savePrepared(
    tx: Tx,
    id: string,
    workings: Record<string, unknown>,
    totals: { totalTaxable: number; totalTax: number },
    preparedBy: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE gst_return_periods
       SET status = 'prepared', workings = $2::jsonb, total_taxable = $3, total_tax = $4,
           prepared_at = now(), prepared_by = $5
       WHERE id = $1`,
      [id, JSON.stringify(workings), totals.totalTaxable, totals.totalTax, preparedBy],
    );
  },

  async markFiled(
    tx: Tx,
    id: string,
    filedBy: string,
    arn: string | null,
    notes: string | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE gst_return_periods
       SET status = 'filed', filed_at = now(), filed_by = $2, arn = $3, notes = $4
       WHERE id = $1`,
      [id, filedBy, arn, notes],
    );
  },
};
