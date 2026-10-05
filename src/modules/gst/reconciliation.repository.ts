import type { Tx } from '../../db/tx.js';
import type { BookInvoice, MatchType, PortalInvoice } from '../../domain/gst/reconcile.js';
import type { Cursor } from '../../lib/pagination.js';

export interface Gstr2bImportRow {
  id: string;
  gstin: string;
  periodYear: number;
  periodMonth: number;
  objectKey: string;
  originalFilename: string | null;
  format: 'json' | 'xlsx';
  status:
    | 'pending'
    | 'ingesting'
    | 'ingested'
    | 'reconciling'
    | 'reconciled'
    | 'failed'
    | 'cancelled';
  invoiceCount: number;
  reconciledUpTo: number;
  exactCount: number;
  probableCount: number;
  missingInBooks: number;
  missingIn2b: number;
  mismatchCount: number;
  errorSummary: Record<string, unknown> | null;
  createdBy: string;
  ingestedAt: Date | null;
  reconciledAt: Date | null;
  createdAt: Date;
}

export interface Gstr2bInvoiceInsert {
  id: string;
  rowNo: number;
  supplierGstin: string;
  supplierName: string | null;
  invoiceNo: string;
  invoiceDate: string;
  documentType: string;
  invoiceValue: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  placeOfSupply: string | null;
  isReverseCharge: boolean;
  itcAvailable: boolean | null;
  itcUnavailableReason: string | null;
  filedPeriod: string | null;
  raw: Record<string, unknown>;
}

export interface MatchRow {
  id: string;
  matchType: MatchType;
  gstr2bInvoiceId: string | null;
  purchaseBillId: string | null;
  differences: Record<string, { ours: unknown; theirs: unknown }> | null;
  taxDifference: number;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  note: string | null;
  /** Joined for the review screen, which needs both sides side by side. */
  portalInvoiceNo: string | null;
  portalInvoiceDate: string | null;
  portalSupplierGstin: string | null;
  portalSupplierName: string | null;
  bookInvoiceNo: string | null;
  bookInvoiceDate: string | null;
  bookDocumentNumber: string | null;
}

const IMPORT_COLUMNS = `
  id, gstin, period_year AS "periodYear", period_month AS "periodMonth",
  object_key AS "objectKey", original_filename AS "originalFilename", format, status,
  invoice_count AS "invoiceCount", reconciled_up_to AS "reconciledUpTo",
  exact_count AS "exactCount", probable_count AS "probableCount",
  missing_in_books AS "missingInBooks", missing_in_2b AS "missingIn2b",
  mismatch_count AS "mismatchCount", error_summary AS "errorSummary",
  created_by AS "createdBy", ingested_at AS "ingestedAt", reconciled_at AS "reconciledAt",
  created_at AS "createdAt"`;

export const reconciliationRepository = {
  findImport(tx: Tx, id: string, forUpdate = false): Promise<Gstr2bImportRow | undefined> {
    return tx.one<Gstr2bImportRow>(
      `SELECT ${IMPORT_COLUMNS} FROM gstr2b_imports WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
  },

  listImports(tx: Tx, limit: number, cursor: Cursor | undefined): Promise<Gstr2bImportRow[]> {
    return tx.many<Gstr2bImportRow>(
      `SELECT ${IMPORT_COLUMNS} FROM gstr2b_imports
       WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [cursor?.k ?? null, cursor?.id ?? null, limit + 1],
    );
  },

  async insertImport(
    tx: Tx,
    input: {
      id: string;
      gstin: string;
      periodYear: number;
      periodMonth: number;
      objectKey: string;
      originalFilename: string | null;
      format: string;
      createdBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO gstr2b_imports (id, tenant_id, gstin, period_year, period_month, object_key,
         original_filename, format, status, created_by, last_progress_at)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, 'pending', $8, now())`,
      [
        input.id,
        input.gstin,
        input.periodYear,
        input.periodMonth,
        input.objectKey,
        input.originalFilename,
        input.format,
        input.createdBy,
      ],
    );
  },

  async setImportStatus(tx: Tx, id: string, status: string): Promise<void> {
    await tx.query(
      'UPDATE gstr2b_imports SET status = $2, last_progress_at = now() WHERE id = $1',
      [id, status],
    );
  },

  async failImport(tx: Tx, id: string, errorSummary: Record<string, unknown>): Promise<void> {
    await tx.query(
      `UPDATE gstr2b_imports SET status = 'failed', error_summary = $2::jsonb,
         last_progress_at = now() WHERE id = $1`,
      [id, JSON.stringify(errorSummary)],
    );
  },

  /** Replaces a previous ingest: a re-upload of the same period starts clean. */
  async clearInvoices(tx: Tx, importId: string): Promise<void> {
    await tx.query('DELETE FROM gstr2b_matches WHERE import_id = $1', [importId]);
    await tx.query('DELETE FROM gstr2b_invoices WHERE import_id = $1', [importId]);
  },

  async insertInvoices(
    tx: Tx,
    importId: string,
    rows: readonly Gstr2bInvoiceInsert[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO gstr2b_invoices (id, tenant_id, import_id, row_no, supplier_gstin,
         supplier_name, invoice_no, invoice_date, document_type, invoice_value, taxable_amount,
         cgst, sgst, igst, cess, place_of_supply, is_reverse_charge, itc_available,
         itc_unavailable_reason, filed_period, raw)
       SELECT r.id, app.current_tenant_id(), $1, r."rowNo", r."supplierGstin", r."supplierName",
              r."invoiceNo", r."invoiceDate", r."documentType", r."invoiceValue",
              r."taxableAmount", r.cgst, r.sgst, r.igst, r.cess, r."placeOfSupply",
              r."isReverseCharge", r."itcAvailable", r."itcUnavailableReason", r."filedPeriod",
              r.raw
       FROM jsonb_to_recordset($2::jsonb) AS r(
         id uuid, "rowNo" int, "supplierGstin" text, "supplierName" text, "invoiceNo" text,
         "invoiceDate" date, "documentType" text, "invoiceValue" bigint, "taxableAmount" bigint,
         cgst bigint, sgst bigint, igst bigint, cess bigint, "placeOfSupply" text,
         "isReverseCharge" boolean, "itcAvailable" boolean, "itcUnavailableReason" text,
         "filedPeriod" text, raw jsonb)`,
      [importId, JSON.stringify(rows)],
    );
  },

  async setInvoiceCount(tx: Tx, id: string, count: number): Promise<void> {
    await tx.query(
      `UPDATE gstr2b_imports SET invoice_count = $2, status = 'ingested', ingested_at = now(),
         last_progress_at = now() WHERE id = $1`,
      [id, count],
    );
  },

  /** The portal's rows, in the shape the pure matcher takes. */
  portalInvoices(tx: Tx, importId: string): Promise<PortalInvoice[]> {
    return tx.many<PortalInvoice>(
      `SELECT id, supplier_gstin AS "supplierGstin", invoice_no AS "invoiceNo",
              invoice_date AS "invoiceDate", taxable_amount AS "taxableAmount",
              (cgst + sgst + igst + cess) AS "totalTax"
       FROM gstr2b_invoices WHERE import_id = $1 ORDER BY row_no`,
      [importId],
    );
  },

  /**
   * The shop's own bills for the comparison window.
   *
   * The window is deliberately wider than the 2B period: a bill of ours dated
   * in March can appear in a supplier's April filing, and a strictly
   * period-bounded comparison reports both as problems — a gap in one month
   * and an unknown invoice in the next. One month either side catches the
   * ordinary late filing without pulling in a year of history.
   */
  bookInvoices(tx: Tx, from: string, to: string): Promise<BookInvoice[]> {
    return tx.many<BookInvoice>(
      `SELECT id, supplier_gstin AS "supplierGstin", supplier_invoice_no AS "supplierInvoiceNo",
              supplier_invoice_date AS "supplierInvoiceDate", taxable_amount AS "taxableAmount",
              (total_cgst + total_sgst + total_igst + total_cess) AS "totalTax"
       FROM purchase_bills
       WHERE status <> 'void'
         AND supplier_invoice_date >= $1::date AND supplier_invoice_date <= $2::date
       ORDER BY supplier_invoice_date, id`,
      [from, to],
    );
  },

  async replaceMatches(
    tx: Tx,
    importId: string,
    rows: readonly {
      id: string;
      matchType: string;
      gstr2bInvoiceId: string | null;
      purchaseBillId: string | null;
      differences: Record<string, unknown> | null;
      taxDifference: number;
    }[],
  ): Promise<void> {
    // A rerun supersedes the previous conclusion, except where someone has
    // accepted a probable match by hand: that is a human decision and
    // re-running must not quietly undo it.
    await tx.query('DELETE FROM gstr2b_matches WHERE import_id = $1 AND accepted_at IS NULL', [
      importId,
    ]);
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO gstr2b_matches (id, tenant_id, import_id, gstr2b_invoice_id, purchase_bill_id,
         match_type, differences, tax_difference)
       SELECT r.id, app.current_tenant_id(), $1, r."gstr2bInvoiceId", r."purchaseBillId",
              r."matchType", r.differences, r."taxDifference"
       FROM jsonb_to_recordset($2::jsonb) AS r(
         id uuid, "gstr2bInvoiceId" uuid, "purchaseBillId" uuid, "matchType" text,
         differences jsonb, "taxDifference" bigint)
       ON CONFLICT DO NOTHING`,
      [importId, JSON.stringify(rows)],
    );
  },

  async recordCounts(
    tx: Tx,
    id: string,
    counts: Record<MatchType, number>,
    finished: boolean,
  ): Promise<void> {
    await tx.query(
      `UPDATE gstr2b_imports
       SET exact_count = $2, probable_count = $3, missing_in_books = $4, missing_in_2b = $5,
           mismatch_count = $6, reconciled_up_to = invoice_count,
           status = CASE WHEN $7 THEN 'reconciled' ELSE 'reconciling' END,
           reconciled_at = CASE WHEN $7 THEN now() ELSE reconciled_at END,
           last_progress_at = now()
       WHERE id = $1`,
      [
        id,
        counts.exact,
        counts.probable,
        counts.missing_in_books,
        counts.missing_in_2b,
        counts.mismatch,
        finished,
      ],
    );
  },

  listMatches(
    tx: Tx,
    importId: string,
    matchType: string | undefined,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<MatchRow[]> {
    return tx.many<MatchRow>(
      `SELECT m.id, m.match_type AS "matchType", m.gstr2b_invoice_id AS "gstr2bInvoiceId",
              m.purchase_bill_id AS "purchaseBillId", m.differences,
              m.tax_difference AS "taxDifference", m.accepted_at AS "acceptedAt",
              m.accepted_by AS "acceptedBy", m.note,
              g.invoice_no AS "portalInvoiceNo", g.invoice_date AS "portalInvoiceDate",
              g.supplier_gstin AS "portalSupplierGstin", g.supplier_name AS "portalSupplierName",
              b.supplier_invoice_no AS "bookInvoiceNo",
              b.supplier_invoice_date AS "bookInvoiceDate",
              b.document_number AS "bookDocumentNumber"
       FROM gstr2b_matches m
       LEFT JOIN gstr2b_invoices g ON g.id = m.gstr2b_invoice_id
       LEFT JOIN purchase_bills b ON b.id = m.purchase_bill_id
       WHERE m.import_id = $1
         AND ($2::text IS NULL OR m.match_type = $2)
         AND ($3::timestamptz IS NULL OR (m.created_at, m.id) < ($3::timestamptz, $4::uuid))
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $5`,
      [importId, matchType ?? null, cursor?.k ?? null, cursor?.id ?? null, limit + 1],
    );
  },

  findMatch(tx: Tx, id: string): Promise<MatchRow | undefined> {
    return tx.one<MatchRow>(
      `SELECT m.id, m.match_type AS "matchType", m.gstr2b_invoice_id AS "gstr2bInvoiceId",
              m.purchase_bill_id AS "purchaseBillId", m.differences,
              m.tax_difference AS "taxDifference", m.accepted_at AS "acceptedAt",
              m.accepted_by AS "acceptedBy", m.note,
              NULL::text AS "portalInvoiceNo", NULL::date AS "portalInvoiceDate",
              NULL::text AS "portalSupplierGstin", NULL::text AS "portalSupplierName",
              NULL::text AS "bookInvoiceNo", NULL::date AS "bookInvoiceDate",
              NULL::text AS "bookDocumentNumber"
       FROM gstr2b_matches m WHERE m.id = $1`,
      [id],
    );
  },

  async acceptMatch(tx: Tx, id: string, acceptedBy: string, note: string | null): Promise<void> {
    await tx.query(
      `UPDATE gstr2b_matches SET accepted_at = now(), accepted_by = $2, note = $3,
         updated_at = now()
       WHERE id = $1`,
      [id, acceptedBy, note],
    );
  },

  /** Total tax on bills the portal does not support: the exposure figure. */
  async creditAtRisk(tx: Tx, importId: string): Promise<number> {
    const row = await tx.one<{ total: string }>(
      `SELECT COALESCE(SUM(abs(tax_difference)), 0)::text AS total
       FROM gstr2b_matches
       WHERE import_id = $1 AND match_type = 'missing_in_2b'`,
      [importId],
    );
    return Number(row?.total ?? 0);
  },
};
