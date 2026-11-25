import { jsonParam } from '../../db/sql.js';
import type { Tx } from '../../db/tx.js';
import type { SupplyCategory, TaxInvoiceResult } from '../../domain/tax/types.js';
import type { Cursor } from '../../lib/pagination.js';
import type { InvoiceHeaderRow } from '../invoices/invoices.repository.js';

export interface DebitNoteRow {
  id: string;
  outletId: string;
  documentNumber: string;
  documentDate: string;
  originalInvoiceId: string;
  originalDocumentNumber: string;
  originalDocumentDate: string;
  customerId: string;
  customerName: string | null;
  customerGstin: string | null;
  supplierGstin: string | null;
  placeOfSupplyStateCode: string | null;
  taxMode: string;
  supplyType: string;
  grossAmount: number;
  taxableAmount: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
  totalTax: number;
  roundOff: number;
  grandTotal: number;
  taxSummary: unknown;
  correctionReason: string;
  isReverseCharge: boolean;
  sezAuthorisedOperations: boolean | null;
  sellerSnapshot: unknown;
  buyerSnapshot: unknown;
  shipToSnapshot: unknown;
  irnState: string;
  notes: string | null;
  status: 'issued' | 'void';
  issuedAt: Date;
  issuedBy: string;
  voidReason: string | null;
}

export interface DebitNoteLineInsert {
  id: string;
  invoiceLineId: string;
  lineNo: number;
  itemId: string | null;
  itemName: string;
  hsnCode: string | null;
  unit: string | null;
  adjustmentKind: 'value' | 'tax';
  taxableAmount: number;
  taxRatePercent: number;
  cessRatePercent: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  lineTotal: number;
  supplyCategory: SupplyCategory;
}

export interface FinancialNoteRow {
  id: string;
  outletId: string;
  documentNumber: string;
  documentDate: string;
  originalInvoiceId: string | null;
  originalDocumentNumber: string | null;
  customerId: string;
  customerName: string | null;
  amount: number;
  reason: string;
  notes: string | null;
  sellerSnapshot: unknown;
  buyerSnapshot: unknown;
  status: 'issued' | 'void';
  issuedAt: Date;
  issuedBy: string;
  voidReason: string | null;
}

const DEBIT_COLUMNS = `
  n.id, n.outlet_id AS "outletId", n.document_number AS "documentNumber", n.document_date AS "documentDate",
  n.original_invoice_id AS "originalInvoiceId", n.original_document_number AS "originalDocumentNumber",
  n.original_document_date AS "originalDocumentDate", n.customer_id AS "customerId", n.customer_name AS "customerName",
  n.customer_gstin AS "customerGstin", n.supplier_gstin AS "supplierGstin",
  n.place_of_supply_state_code AS "placeOfSupplyStateCode", n.tax_mode AS "taxMode", n.supply_type AS "supplyType",
  n.gross_amount AS "grossAmount", n.taxable_amount AS "taxableAmount", n.total_cgst AS "totalCgst",
  n.total_sgst AS "totalSgst", n.total_igst AS "totalIgst", n.total_cess AS "totalCess", n.total_tax AS "totalTax",
  n.round_off AS "roundOff", n.grand_total AS "grandTotal", n.tax_summary AS "taxSummary",
  n.correction_reason AS "correctionReason", n.is_reverse_charge AS "isReverseCharge",
  n.sez_authorised_operations AS "sezAuthorisedOperations", n.seller_snapshot AS "sellerSnapshot",
  n.buyer_snapshot AS "buyerSnapshot", n.ship_to_snapshot AS "shipToSnapshot", n.irn_state AS "irnState", n.notes,
  n.status, n.issued_at AS "issuedAt", n.issued_by AS "issuedBy", n.void_reason AS "voidReason"`;

const FINANCIAL_COLUMNS = `
  n.id, n.outlet_id AS "outletId", n.document_number AS "documentNumber", n.document_date AS "documentDate",
  n.original_invoice_id AS "originalInvoiceId", n.original_document_number AS "originalDocumentNumber",
  n.customer_id AS "customerId", n.customer_name AS "customerName", n.amount, n.reason, n.notes,
  n.seller_snapshot AS "sellerSnapshot", n.buyer_snapshot AS "buyerSnapshot", n.status, n.issued_at AS "issuedAt",
  n.issued_by AS "issuedBy", n.void_reason AS "voidReason"`;

interface ListFilter {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly status?: string | undefined;
  readonly customerId?: string | undefined;
  readonly originalInvoiceId?: string | undefined;
}

function listSql(table: string, columns: string): string {
  return `SELECT ${columns} FROM ${table} n
    WHERE ($1::date IS NULL OR n.document_date >= $1)
      AND ($2::date IS NULL OR n.document_date <= $2)
      AND ($3::text IS NULL OR n.status = $3)
      AND ($4::uuid IS NULL OR n.customer_id = $4)
      AND ($5::uuid IS NULL OR n.original_invoice_id = $5)
      AND ($6::uuid[] IS NULL OR n.outlet_id = ANY($6::uuid[]))
      AND ($7::date IS NULL OR (n.document_date, n.id) < ($7::date, $8::uuid))
    ORDER BY n.document_date DESC, n.id DESC
    LIMIT $9`;
}

function listParams(f: ListFilter, restrictTo: readonly string[] | null, limit: number, cursor: Cursor | undefined) {
  return [
    f.from ?? null,
    f.to ?? null,
    f.status ?? null,
    f.customerId ?? null,
    f.originalInvoiceId ?? null,
    restrictTo ? [...restrictTo] : null,
    cursor ? String(cursor.k) : null,
    cursor?.id ?? null,
    limit + 1,
  ];
}

export const adjustmentNotesRepository = {
  async debitNoteExists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>('SELECT EXISTS (SELECT 1 FROM sales_debit_notes WHERE id = $1) AS found', [id]);
    return row?.found ?? false;
  },

  findDebitNote(tx: Tx, id: string, forUpdate = false): Promise<DebitNoteRow | undefined> {
    return tx.one<DebitNoteRow>(
      `SELECT ${DEBIT_COLUMNS} FROM sales_debit_notes n WHERE n.id = $1 ${forUpdate ? 'FOR UPDATE OF n' : ''}`,
      [id],
    );
  },

  findDebitNoteLines(tx: Tx, id: string) {
    return tx.many(
      `SELECT id, invoice_line_id AS "invoiceLineId", line_no AS "lineNo", item_id AS "itemId", item_name AS "itemName",
              hsn_code AS "hsnCode", unit, adjustment_kind AS "adjustmentKind", taxable_amount AS "taxableAmount",
              tax_rate_percent AS "taxRatePercent", cess_rate_percent AS "cessRatePercent", cgst, sgst, igst, cess,
              line_total AS "lineTotal", supply_category AS "supplyCategory"
       FROM sales_debit_note_lines WHERE sales_debit_note_id = $1 ORDER BY line_no`,
      [id],
    );
  },

  listDebitNotes(tx: Tx, f: ListFilter, restrictTo: readonly string[] | null, limit: number, cursor: Cursor | undefined) {
    return tx.many<DebitNoteRow>(listSql('sales_debit_notes', DEBIT_COLUMNS), listParams(f, restrictTo, limit, cursor));
  },

  /** Parties, place of supply and registration all come from the invoice it adjusts. */
  async insertDebitNote(
    tx: Tx,
    h: {
      id: string;
      series: { id: string; counterId: string | null };
      deviceId: string;
      sequenceNo: number;
      documentNumber: string;
      documentDate: string;
      fyStartYear: number;
      invoice: InvoiceHeaderRow;
      correctionReason: string;
      totals: TaxInvoiceResult;
      notes: string | null;
      issuedAt: string;
      issuedBy: string;
    },
  ): Promise<void> {
    const t = h.totals;
    await tx.query(
      `INSERT INTO sales_debit_notes (
         id, tenant_id, outlet_id, counter_id, device_id, series_id, sequence_no, document_number, document_date, fy_start_year,
         original_invoice_id, original_document_number, original_document_date, customer_id, customer_name, customer_gstin,
         customer_uin, supplier_gstin, supplier_state_code, place_of_supply_state_code, tax_mode, supply_type, round_off_enabled,
         gross_amount, taxable_amount, total_cgst, total_sgst, total_igst, total_cess, total_tax, sub_total, round_off, grand_total,
         tax_summary, hsn_summary, correction_reason, is_reverse_charge, tax_payable_by, registration_id, registration_resolution,
         document_type, supply_scenario, pos_provision, sez_authorised_operations, lut_reference, buyer_gst_treatment,
         seller_snapshot, buyer_snapshot, ship_to_snapshot, dispatch_from_snapshot, notes, status, issued_at, issued_by)
       SELECT $1, app.current_tenant_id(), i.outlet_id, $2, $3, $4, $5, $6, $7, $8,
              i.id, i.document_number, i.document_date, i.customer_id, i.customer_name, i.customer_gstin,
              i.customer_uin, i.supplier_gstin, i.supplier_state_code, i.place_of_supply_state_code, $9, $10, i.round_off_enabled,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
              $21::jsonb, $22::jsonb, $23, $24, i.tax_payable_by, i.registration_id, i.registration_resolution,
              i.document_type, i.supply_scenario, i.pos_provision, i.sez_authorised_operations, i.lut_reference, i.buyer_gst_treatment,
              i.seller_snapshot, i.buyer_snapshot, i.ship_to_snapshot, i.dispatch_from_snapshot, $25, 'issued', $26, $27
         FROM invoices i WHERE i.id = $28`,
      [
        h.id,
        h.series.counterId,
        h.deviceId,
        h.series.id,
        h.sequenceNo,
        h.documentNumber,
        h.documentDate,
        h.fyStartYear,
        t.mode,
        t.supplyType,
        t.grossAmount,
        t.taxableAmount,
        t.totalCgst,
        t.totalSgst,
        t.totalIgst,
        t.totalCess,
        t.totalTax,
        t.subTotal,
        t.roundOff,
        t.grandTotal,
        JSON.stringify(t.taxSummary),
        JSON.stringify(t.hsnSummary),
        h.correctionReason,
        t.isReverseCharge,
        h.notes,
        h.issuedAt,
        h.issuedBy,
        h.invoice.id,
      ],
    );
  },

  async insertDebitNoteLines(
    tx: Tx,
    noteId: string,
    outletId: string,
    documentDate: string,
    lines: readonly DebitNoteLineInsert[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO sales_debit_note_lines (id, tenant_id, sales_debit_note_id, invoice_line_id, outlet_id, document_date, line_no,
         item_id, item_name, hsn_code, unit, adjustment_kind, taxable_amount, tax_rate_percent, cess_rate_percent, cgst, sgst, igst,
         cess, line_total, supply_category)
       SELECT l.id, app.current_tenant_id(), $1, l."invoiceLineId", $2, $3, l."lineNo", l."itemId", l."itemName", l."hsnCode", l.unit,
              l."adjustmentKind", l."taxableAmount", l."taxRatePercent", l."cessRatePercent", l.cgst, l.sgst, l.igst, l.cess,
              l."lineTotal", l."supplyCategory"
       FROM jsonb_to_recordset($4::jsonb) AS l(
         id uuid, "invoiceLineId" uuid, "lineNo" int, "itemId" uuid, "itemName" text, "hsnCode" text, unit text,
         "adjustmentKind" text, "taxableAmount" bigint, "taxRatePercent" numeric, "cessRatePercent" numeric, cgst bigint,
         sgst bigint, igst bigint, cess bigint, "lineTotal" bigint, "supplyCategory" text)`,
      [noteId, outletId, documentDate, JSON.stringify(lines)],
    );
  },

  async markDebitNoteVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      "UPDATE sales_debit_notes SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3 WHERE id = $1",
      [id, reason, userId],
    );
  },

  findFinancialNote(tx: Tx, id: string, forUpdate = false): Promise<FinancialNoteRow | undefined> {
    return tx.one<FinancialNoteRow>(
      `SELECT ${FINANCIAL_COLUMNS} FROM financial_credit_notes n WHERE n.id = $1 ${forUpdate ? 'FOR UPDATE OF n' : ''}`,
      [id],
    );
  },

  listFinancialNotes(tx: Tx, f: ListFilter, restrictTo: readonly string[] | null, limit: number, cursor: Cursor | undefined) {
    return tx.many<FinancialNoteRow>(listSql('financial_credit_notes', FINANCIAL_COLUMNS), listParams(f, restrictTo, limit, cursor));
  },

  async insertFinancialNote(
    tx: Tx,
    n: {
      id: string;
      outletId: string;
      deviceId: string;
      seriesId: string;
      sequenceNo: number;
      documentNumber: string;
      documentDate: string;
      fyStartYear: number;
      originalInvoiceId: string | null;
      originalDocumentNumber: string | null;
      customerId: string;
      customerName: string;
      amount: number;
      reason: string;
      notes: string | null;
      sellerSnapshot: unknown;
      buyerSnapshot: unknown;
      issuedAt: string;
      issuedBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO financial_credit_notes (id, tenant_id, outlet_id, device_id, series_id, sequence_no, document_number, document_date,
         fy_start_year, original_invoice_id, original_document_number, customer_id, customer_name, amount, reason, notes,
         seller_snapshot, buyer_snapshot, status, issued_at, issued_by)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'issued', $18, $19)`,
      [
        n.id,
        n.outletId,
        n.deviceId,
        n.seriesId,
        n.sequenceNo,
        n.documentNumber,
        n.documentDate,
        n.fyStartYear,
        n.originalInvoiceId,
        n.originalDocumentNumber,
        n.customerId,
        n.customerName,
        n.amount,
        n.reason,
        n.notes,
        jsonParam(n.sellerSnapshot),
        jsonParam(n.buyerSnapshot),
        n.issuedAt,
        n.issuedBy,
      ],
    );
  },

  async markFinancialNoteVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      "UPDATE financial_credit_notes SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3 WHERE id = $1",
      [id, reason, userId],
    );
  },
};
