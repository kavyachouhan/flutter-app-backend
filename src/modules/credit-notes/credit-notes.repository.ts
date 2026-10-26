import type { Tx } from '../../db/tx.js';
import { jsonParam } from '../../db/sql.js';
import type {
  Discount,
  SupplyCategory,
  TaxInvoiceResult,
} from '../../domain/tax/types.js';
import type { Cursor } from '../../lib/pagination.js';

export interface CreditNoteHeaderInsert {
  id: string;
  outletId: string;
  counterId: string | null;
  deviceId: string;
  seriesId: string;
  sequenceNo: number;
  documentNumber: string;
  documentDate: string;
  fyStartYear: number;
  originalInvoiceId: string;
  originalDocumentNumber: string;
  customerId: string | null;
  customerName: string | null;
  customerGstin: string | null;
  supplierGstin: string | null;
  supplierStateCode: string;
  placeOfSupplyStateCode: string | null;
  pricesIncludeTax: boolean;
  roundOffEnabled: boolean;
  totals: TaxInvoiceResult;
  reasonCode: string;
  refundMode: string;
  refundAmount: number;
  restock: boolean;
  customFields: Record<string, string> | null;
  notes: string | null;
  issuedAt: string;
  issuedBy: string;
}

export interface CreditNoteLineInsert {
  id: string;
  invoiceLineId: string;
  lineNo: number;
  itemId: string | null;
  itemName: string;
  hsnCode: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  discount: Discount | null;
  grossAmount: number;
  lineDiscount: number;
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

export interface CreditNoteHeaderRow {
  id: string;
  outletId: string;
  originalInvoiceId: string;
  customerId: string | null;
  grandTotal: number;
  refundMode: string;
  refundAmount: number;
  restock: boolean;
  documentNumber: string;
  status: 'issued' | 'void';
  [column: string]: unknown;
}

export interface CreditNoteSummaryRow {
  id: string;
  outletId: string;
  documentNumber: string;
  documentDate: string;
  originalInvoiceId: string;
  originalDocumentNumber: string;
  customerId: string | null;
  customerName: string | null;
  grandTotal: number;
  refundMode: string;
  status: 'issued' | 'void';
}

/** An invoice line with what has already gone back on non-void credit notes. */
export interface SoldLineRow {
  id: string;
  invoiceId: string;
  lineNo: number;
  itemId: string | null;
  itemName: string;
  hsnCode: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  lineDiscount: number;
  billDiscountShare: number;
  taxRatePercent: number;
  cessRatePercent: number;
  supplyCategory: SupplyCategory;
  trackStock: boolean;
  returnedQuantity: number;
}

export interface CreditNoteListFilter {
  from: string | undefined;
  to: string | undefined;
  status: string | undefined;
  customerId: string | undefined;
  outletId: string | undefined;
  originalInvoiceId: string | undefined;
}

const HEADER_COLUMNS = `
  c.id, c.outlet_id AS "outletId", c.counter_id AS "counterId", c.device_id AS "deviceId", c.series_id AS "seriesId",
  c.sequence_no AS "sequenceNo", c.document_number AS "documentNumber", c.document_date AS "documentDate",
  c.fy_start_year AS "fyStartYear", c.original_invoice_id AS "originalInvoiceId",
  c.original_document_number AS "originalDocumentNumber", c.customer_id AS "customerId", c.customer_name AS "customerName",
  c.customer_gstin AS "customerGstin", c.supplier_gstin AS "supplierGstin", c.supplier_state_code AS "supplierStateCode",
  c.place_of_supply_state_code AS "placeOfSupplyStateCode", c.tax_mode AS "taxMode", c.supply_type AS "supplyType",
  c.prices_include_tax AS "pricesIncludeTax", c.round_off_enabled AS "roundOffEnabled",
  c.gross_amount AS "grossAmount", c.line_discount_total AS "lineDiscountTotal", c.bill_discount_amount AS "billDiscountAmount",
  c.taxable_amount AS "taxableAmount", c.total_cgst AS "totalCgst", c.total_sgst AS "totalSgst", c.total_igst AS "totalIgst",
  c.total_cess AS "totalCess", c.total_tax AS "totalTax", c.sub_total AS "subTotal", c.round_off AS "roundOff",
  c.grand_total AS "grandTotal", c.tax_summary AS "taxSummary", c.hsn_summary AS "hsnSummary",
  c.reason_code AS "reasonCode", c.refund_mode AS "refundMode", c.refund_amount AS "refundAmount", c.restock,
  c.custom_fields AS "customFields", c.notes, c.status, c.issued_at AS "issuedAt", c.issued_by AS "issuedBy",
  c.void_reason AS "voidReason", c.voided_at AS "voidedAt", c.voided_by AS "voidedBy",
  c.print_count AS "printCount", c.printed_at AS "printedAt",
  c.is_reverse_charge AS "isReverseCharge", c.created_at AS "createdAt"`;

const LINE_COLUMNS = `
  id, invoice_line_id AS "invoiceLineId", line_no AS "lineNo", item_id AS "itemId", item_name AS "itemName",
  hsn_code AS "hsnCode", unit, quantity, unit_price AS "unitPrice", discount, gross_amount AS "grossAmount",
  line_discount AS "lineDiscount", taxable_amount AS "taxableAmount", tax_rate_percent AS "taxRatePercent",
  cess_rate_percent AS "cessRatePercent", cgst, sgst, igst, cess, line_total AS "lineTotal",
  supply_category AS "supplyCategory"`;

export const creditNotesRepository = {
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM credit_notes WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  /** Lines of an invoice with the quantity already returned, locked against concurrent returns. */
  /**
   * The invoice's lines with what has already been returned on each.
   *
   * Never `FOR UPDATE OF l`: invoice_lines is immutable, so the runtime role has no
   * UPDATE privilege on it and a row lock is refused. The caller locks the invoice
   * header instead, which serialises two returns of the same invoice just as well.
   */
  soldLines(tx: Tx, invoiceId: string, _lockedByHeader = false): Promise<SoldLineRow[]> {
    return tx.many<SoldLineRow>(
      `SELECT l.id, l.invoice_id AS "invoiceId", l.line_no AS "lineNo", l.item_id AS "itemId", l.item_name AS "itemName",
              l.hsn_code AS "hsnCode", l.unit, l.quantity, l.unit_price AS "unitPrice", l.line_discount AS "lineDiscount",
              l.bill_discount_share AS "billDiscountShare", l.tax_rate_percent AS "taxRatePercent",
              l.cess_rate_percent AS "cessRatePercent", l.supply_category AS "supplyCategory",
              COALESCE(i.track_stock, false) AS "trackStock",
              COALESCE((SELECT SUM(cl.quantity) FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
                        WHERE cl.invoice_line_id = l.id AND c.status = 'issued'), 0) AS "returnedQuantity"
       FROM invoice_lines l LEFT JOIN items i ON i.id = l.item_id
       WHERE l.invoice_id = $1
       ORDER BY l.line_no`,
      [invoiceId],
    );
  },

  /** True while any credit note against the invoice still stands. */
  async hasIssuedForInvoice(tx: Tx, invoiceId: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM credit_notes
                      WHERE original_invoice_id = $1 AND status = 'issued') AS found`,
      [invoiceId],
    );
    return row?.found ?? false;
  },

  /** The credit notes against an invoice, oldest first, for the invoice's detail view. */
  listForInvoice(tx: Tx, invoiceId: string) {
    return tx.many<{
      id: string;
      documentNumber: string;
      documentDate: string;
      grandTotal: number;
      status: string;
    }>(
      `SELECT id, document_number AS "documentNumber", document_date AS "documentDate",
              grand_total AS "grandTotal", status
       FROM credit_notes WHERE original_invoice_id = $1 ORDER BY issued_at, id`,
      [invoiceId],
    );
  },

  async insertHeader(tx: Tx, h: CreditNoteHeaderInsert): Promise<void> {
    const t = h.totals;
    await tx.query(
      `INSERT INTO credit_notes (
         id, tenant_id, outlet_id, counter_id, device_id, series_id, sequence_no, document_number, document_date,
         fy_start_year, original_invoice_id, original_document_number, customer_id, customer_name, customer_gstin,
         supplier_gstin, supplier_state_code, place_of_supply_state_code, tax_mode, supply_type, prices_include_tax,
         round_off_enabled, gross_amount, line_discount_total, bill_discount_amount, taxable_amount, total_cgst,
         total_sgst, total_igst, total_cess, total_tax, sub_total, round_off, grand_total, tax_summary, hsn_summary,
         reason_code, refund_mode, refund_amount, restock, custom_fields, notes, status, issued_at, issued_by,
         is_reverse_charge)
       VALUES (
         $1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20,
         $21, $22, $23, $24, $25, $26,
         $27, $28, $29, $30, $31, $32, $33, $34, $35,
         $36, $37, $38, $39, $40, $41, 'issued', $42, $43, $44)`,
      [
        h.id,
        h.outletId,
        h.counterId,
        h.deviceId,
        h.seriesId,
        h.sequenceNo,
        h.documentNumber,
        h.documentDate,
        h.fyStartYear,
        h.originalInvoiceId,
        h.originalDocumentNumber,
        h.customerId,
        h.customerName,
        h.customerGstin,
        h.supplierGstin,
        h.supplierStateCode,
        h.placeOfSupplyStateCode,
        t.mode,
        t.supplyType,
        h.pricesIncludeTax,
        h.roundOffEnabled,
        t.grossAmount,
        t.totalLineDiscount,
        t.billDiscount,
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
        h.reasonCode,
        h.refundMode,
        h.refundAmount,
        h.restock,
        jsonParam(h.customFields),
        h.notes,
        h.issuedAt,
        h.issuedBy,
        t.isReverseCharge,
      ],
    );
  },

  async insertLines(
    tx: Tx,
    creditNoteId: string,
    outletId: string,
    documentDate: string,
    lines: readonly CreditNoteLineInsert[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO credit_note_lines (id, tenant_id, credit_note_id, invoice_line_id, outlet_id, document_date, line_no,
         item_id, item_name, hsn_code, unit, quantity, unit_price, discount, gross_amount, line_discount,
         taxable_amount, tax_rate_percent, cess_rate_percent, cgst, sgst, igst, cess, line_total,
         supply_category)
       SELECT l.id, app.current_tenant_id(), $1, l."invoiceLineId", $2, $3, l."lineNo",
              l."itemId", l."itemName", l."hsnCode", l.unit, l.quantity, l."unitPrice", l.discount, l."grossAmount",
              l."lineDiscount", l."taxableAmount", l."taxRatePercent", l."cessRatePercent", l.cgst, l.sgst, l.igst,
              l.cess, l."lineTotal", l."supplyCategory"
       FROM jsonb_to_recordset($4::jsonb) AS l(
         id uuid, "invoiceLineId" uuid, "lineNo" int, "itemId" uuid, "itemName" text, "hsnCode" text, unit text,
         quantity bigint, "unitPrice" bigint, discount jsonb, "grossAmount" bigint, "lineDiscount" bigint,
         "taxableAmount" bigint, "taxRatePercent" numeric, "cessRatePercent" numeric, cgst bigint, sgst bigint,
         igst bigint, cess bigint, "lineTotal" bigint, "supplyCategory" text)`,
      [creditNoteId, outletId, documentDate, JSON.stringify(lines)],
    );
  },

  findHeader(tx: Tx, id: string, forUpdate = false): Promise<CreditNoteHeaderRow | undefined> {
    return tx.one<CreditNoteHeaderRow>(
      `SELECT ${HEADER_COLUMNS} FROM credit_notes c WHERE c.id = $1 ${forUpdate ? 'FOR UPDATE OF c' : ''}`,
      [id],
    );
  },

  findLines(tx: Tx, creditNoteId: string) {
    return tx.many(
      `SELECT ${LINE_COLUMNS} FROM credit_note_lines WHERE credit_note_id = $1 ORDER BY line_no`,
      [creditNoteId],
    );
  },

  list(
    tx: Tx,
    filter: CreditNoteListFilter,
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<CreditNoteSummaryRow[]> {
    return tx.many<CreditNoteSummaryRow>(
      `SELECT c.id, c.outlet_id AS "outletId", c.document_number AS "documentNumber", c.document_date AS "documentDate",
              c.original_invoice_id AS "originalInvoiceId", c.original_document_number AS "originalDocumentNumber",
              c.customer_id AS "customerId", c.customer_name AS "customerName", c.grand_total AS "grandTotal",
              c.refund_mode AS "refundMode", c.status
       FROM credit_notes c
       WHERE ($1::date IS NULL OR c.document_date >= $1)
         AND ($2::date IS NULL OR c.document_date <= $2)
         AND ($3::text IS NULL OR c.status = $3)
         AND ($4::uuid IS NULL OR c.customer_id = $4)
         AND ($5::uuid IS NULL OR c.outlet_id = $5)
         AND ($6::uuid IS NULL OR c.original_invoice_id = $6)
         AND ($7::uuid[] IS NULL OR c.outlet_id = ANY($7::uuid[]))
         AND ($8::date IS NULL OR (c.document_date, c.id) < ($8::date, $9::uuid))
       ORDER BY c.document_date DESC, c.id DESC
       LIMIT $10`,
      [
        filter.from ?? null,
        filter.to ?? null,
        filter.status ?? null,
        filter.customerId ?? null,
        filter.outletId ?? null,
        filter.originalInvoiceId ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async markVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      "UPDATE credit_notes SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3 WHERE id = $1",
      [id, reason, userId],
    );
  },

  async markPrinted(tx: Tx, id: string): Promise<void> {
    await tx.query(
      'UPDATE credit_notes SET print_count = print_count + 1, printed_at = now() WHERE id = $1',
      [id],
    );
  },
};
