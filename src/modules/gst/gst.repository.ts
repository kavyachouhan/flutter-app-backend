import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export interface GstReturnPeriodRow {
  id: string;
  gstin: string;
  returnType: 'gstr1' | 'gstr3b' | 'cmp08';
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

/**
 * One outward document, flattened for classification.
 *
 * Invoices and credit notes come back from one query: GSTR-1 reports them
 * against the same tables and in the same period, and fetching them separately
 * would mean interleaving two cursors to keep the totals aligned.
 */
export interface OutwardDocumentRow {
  id: string;
  kind: 'invoice' | 'credit_note';
  documentNumber: string;
  documentDate: string;
  customerGstin: string | null;
  customerName: string | null;
  placeOfSupplyStateCode: string | null;
  supplyType: string;
  isReverseCharge: boolean;
  taxableAmount: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
  grandTotal: number;
  /** The original invoice number, for a credit note in the CDN tables. */
  originalDocumentNumber: string | null;
  /** Distinct line classifications, so a wholly exempt document is visible. */
  lineCategories: string[];
  /** Rate-wise rows, for the B2CS aggregate and the 3B sections. */
  taxSummary: { taxRatePercent: number; taxableAmount: number }[];
}

export interface HsnSummaryRow {
  hsnCode: string;
  description: string | null;
  unit: string | null;
  quantity: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

export interface CategoryTotalRow {
  supplyCategory: string;
  supplyType: string;
  taxableAmount: number;
}

const PERIOD_COLUMNS = `
  id, gstin, return_type AS "returnType", period_year AS "periodYear",
  period_month AS "periodMonth", period_from AS "periodFrom", period_to AS "periodTo",
  status, workings, total_taxable AS "totalTaxable", total_tax AS "totalTax",
  prepared_at AS "preparedAt", prepared_by AS "preparedBy", filed_at AS "filedAt",
  filed_by AS "filedBy", arn, notes, created_at AS "createdAt"`;

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
    filter: { gstin: string | undefined; returnType: string | undefined; status: string | undefined },
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<GstReturnPeriodRow[]> {
    return tx.many<GstReturnPeriodRow>(
      `SELECT ${PERIOD_COLUMNS} FROM gst_return_periods
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

  /**
   * Every outward document in a period, for the GSTR-1 tables.
   *
   * Scoped by the *resolved* GSTIN rather than by outlet: a business with a
   * registration per state files a return per registration, and an outlet
   * whose GSTIN overrides the tenant's belongs to that outlet's return.
   * `supplier_gstin` on the document is the snapshot taken when it was issued,
   * which is the only figure that stays right after a GSTIN changes.
   *
   * Void documents are excluded. A voided invoice was never a supply, and its
   * number is accounted for separately in the table-13 gap report.
   */
  outwardDocuments(
    tx: Tx,
    gstin: string,
    from: string,
    to: string,
  ): Promise<OutwardDocumentRow[]> {
    return tx.many<OutwardDocumentRow>(
      `SELECT i.id, 'invoice' AS kind, i.document_number AS "documentNumber",
              i.document_date AS "documentDate", i.customer_gstin AS "customerGstin",
              i.customer_name AS "customerName",
              i.place_of_supply_state_code AS "placeOfSupplyStateCode",
              i.supply_type AS "supplyType", i.is_reverse_charge AS "isReverseCharge",
              i.taxable_amount AS "taxableAmount", i.total_cgst AS "totalCgst",
              i.total_sgst AS "totalSgst", i.total_igst AS "totalIgst",
              i.total_cess AS "totalCess", i.grand_total AS "grandTotal",
              NULL::text AS "originalDocumentNumber",
              COALESCE((SELECT array_agg(DISTINCT l.supply_category)
                        FROM invoice_lines l WHERE l.invoice_id = i.id), '{}') AS "lineCategories",
              i.tax_summary AS "taxSummary"
       FROM invoices i
       WHERE i.supplier_gstin = $1 AND i.status <> 'void'
         AND i.document_date >= $2::date AND i.document_date <= $3::date
       UNION ALL
       SELECT c.id, 'credit_note' AS kind, c.document_number AS "documentNumber",
              c.document_date AS "documentDate", c.customer_gstin AS "customerGstin",
              c.customer_name AS "customerName",
              c.place_of_supply_state_code AS "placeOfSupplyStateCode",
              c.supply_type AS "supplyType", c.is_reverse_charge AS "isReverseCharge",
              c.taxable_amount AS "taxableAmount", c.total_cgst AS "totalCgst",
              c.total_sgst AS "totalSgst", c.total_igst AS "totalIgst",
              c.total_cess AS "totalCess", c.grand_total AS "grandTotal",
              c.original_document_number AS "originalDocumentNumber",
              COALESCE((SELECT array_agg(DISTINCT l.supply_category)
                        FROM credit_note_lines l WHERE l.credit_note_id = c.id), '{}')
                AS "lineCategories",
              c.tax_summary AS "taxSummary"
       FROM credit_notes c
       WHERE c.supplier_gstin = $1 AND c.status <> 'void'
         AND c.document_date >= $2::date AND c.document_date <= $3::date
       ORDER BY "documentDate", "documentNumber"`,
      [gstin, from, to],
    );
  },

  /**
   * HSN-wise outward summary, GSTR-1 table 12.
   *
   * Built from the line tables rather than from the stored `hsn_summary`
   * JSONB on each header: that snapshot is per document, and summing JSONB
   * across a month in SQL is both slower and harder to read than aggregating
   * the lines it was derived from. Credit-note lines subtract, so the table
   * reconciles to the period's net supply.
   *
   * Lines with no HSN are reported under a reserved code rather than dropped,
   * because the table has to account for every rupee of the turnover above it.
   */
  hsnSummary(tx: Tx, gstin: string, from: string, to: string): Promise<HsnSummaryRow[]> {
    return tx.many<HsnSummaryRow>(
      `WITH lines AS (
         SELECT COALESCE(NULLIF(trim(l.hsn_code), ''), 'UNCLASSIFIED') AS hsn_code,
                l.unit, l.quantity, l.taxable_amount, l.cgst, l.sgst, l.igst, l.cess
         FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
         WHERE i.supplier_gstin = $1 AND i.status <> 'void'
           AND l.document_date >= $2::date AND l.document_date <= $3::date
         UNION ALL
         SELECT COALESCE(NULLIF(trim(l.hsn_code), ''), 'UNCLASSIFIED') AS hsn_code,
                l.unit, -l.quantity, -l.taxable_amount, -l.cgst, -l.sgst, -l.igst, -l.cess
         FROM credit_note_lines l
         JOIN credit_notes c ON c.id = l.credit_note_id
         WHERE c.supplier_gstin = $1 AND c.status <> 'void'
           AND l.document_date >= $2::date AND l.document_date <= $3::date
       )
       SELECT hsn_code AS "hsnCode", NULL::text AS description,
              (array_agg(unit) FILTER (WHERE unit IS NOT NULL))[1] AS unit,
              SUM(quantity)::bigint AS quantity, SUM(taxable_amount)::bigint AS "taxableAmount",
              SUM(cgst)::bigint AS cgst, SUM(sgst)::bigint AS sgst,
              SUM(igst)::bigint AS igst, SUM(cess)::bigint AS cess
       FROM lines
       GROUP BY hsn_code
       ORDER BY hsn_code`,
      [gstin, from, to],
    );
  },

  /**
   * Taxable value by classification and supply type, for GSTR-1 table 8 and
   * the GSTR-3B 3.1 sections.
   *
   * Net of credit notes, like the HSN table, so the sections add up to the
   * period's actual supply.
   */
  categoryTotals(tx: Tx, gstin: string, from: string, to: string): Promise<CategoryTotalRow[]> {
    return tx.many<CategoryTotalRow>(
      `WITH lines AS (
         SELECT l.supply_category, i.supply_type, l.taxable_amount
         FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE i.supplier_gstin = $1 AND i.status <> 'void'
           AND l.document_date >= $2::date AND l.document_date <= $3::date
         UNION ALL
         SELECT l.supply_category, c.supply_type, -l.taxable_amount
         FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id
         WHERE c.supplier_gstin = $1 AND c.status <> 'void'
           AND l.document_date >= $2::date AND l.document_date <= $3::date
       )
       SELECT supply_category AS "supplyCategory", supply_type AS "supplyType",
              SUM(taxable_amount)::bigint AS "taxableAmount"
       FROM lines
       GROUP BY supply_category, supply_type`,
      [gstin, from, to],
    );
  },

  /**
   * Documents issued in the period, GSTR-1 table 13.
   *
   * Reads the series rather than the documents: the table declares the range
   * a business issued and how many of those numbers were cancelled, so an
   * unused number has to be counted even though no document exists for it.
   */
  documentsIssued(
    tx: Tx,
    from: string,
    to: string,
  ): Promise<
    { documentType: string; seriesId: string; fromNo: string; toNo: string; issued: number }[]
  > {
    return tx.many(
      `SELECT s.document_type AS "documentType", s.id AS "seriesId",
              MIN(d.document_number) AS "fromNo", MAX(d.document_number) AS "toNo",
              COUNT(*)::int AS issued
       FROM (
         SELECT series_id, document_number, document_date FROM invoices WHERE status <> 'void'
         UNION ALL
         SELECT series_id, document_number, document_date FROM credit_notes WHERE status <> 'void'
         UNION ALL
         SELECT series_id, document_number, document_date FROM debit_notes WHERE status <> 'void'
       ) d
       JOIN document_series s ON s.id = d.series_id
       WHERE d.document_date >= $1::date AND d.document_date <= $2::date
       GROUP BY s.document_type, s.id
       ORDER BY s.document_type, s.id`,
      [from, to],
    );
  },

  /**
   * Inward supplies liable to reverse charge, for GSTR-3B 3.1(d) and the
   * matching credit in table 4.
   *
   * The tax is computed from the line rates rather than read from the tax
   * columns, because a reverse-charge bill carries no tax — the supplier
   * charged none. The liability is the shop's own to self-assess, and the
   * rates are retained on the lines precisely so it can be.
   */
  reverseChargeInward(
    tx: Tx,
    from: string,
    to: string,
  ): Promise<{ taxableAmount: number; tax: number }[]> {
    return tx.many(
      `SELECT SUM(l.taxable_amount)::bigint AS "taxableAmount",
              SUM(round(l.taxable_amount * (l.tax_rate_percent + l.cess_rate_percent) / 100))::bigint
                AS tax
       FROM purchase_bill_lines l
       JOIN purchase_bills b ON b.id = l.purchase_bill_id
       WHERE b.is_reverse_charge AND b.status <> 'void'
         AND l.document_date >= $1::date AND l.document_date <= $2::date`,
      [from, to],
    );
  },

  /** Composition turnover for a CMP-08 period: billed value net of returns. */
  compositionTurnover(
    tx: Tx,
    gstin: string,
    from: string,
    to: string,
  ): Promise<{ outwardSupplies: number } | undefined> {
    return tx.one(
      `SELECT (
         COALESCE((SELECT SUM(grand_total) FROM invoices
                   WHERE supplier_gstin = $1 AND status <> 'void'
                     AND document_date >= $2::date AND document_date <= $3::date), 0)
         - COALESCE((SELECT SUM(grand_total) FROM credit_notes
                     WHERE supplier_gstin = $1 AND status <> 'void'
                       AND document_date >= $2::date AND document_date <= $3::date), 0)
       )::bigint AS "outwardSupplies"`,
      [gstin, from, to],
    );
  },
};
