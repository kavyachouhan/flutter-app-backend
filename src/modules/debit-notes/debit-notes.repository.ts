import type { Tx } from '../../db/tx.js';
import type { SupplyCategory, TaxInvoiceResult } from '../../domain/tax/types.js';
import type { Cursor } from '../../lib/pagination.js';

export interface DebitNoteHeaderInsert {
  id: string;
  outletId: string;
  supplierId: string;
  purchaseBillId: string;
  originalDocumentNumber: string;
  seriesId: string;
  sequenceNo: number;
  documentNumber: string;
  documentDate: string;
  fyStartYear: number;
  supplierGstin: string | null;
  supplierStateCode: string | null;
  placeOfSupplyStateCode: string | null;
  pricesIncludeTax: boolean;
  roundOffEnabled: boolean;
  totals: TaxInvoiceResult;
  reasonCode: string;
  restock: boolean;
  notes: string | null;
  issuedAt: string;
  issuedBy: string;
}

export interface DebitNoteLineInsert {
  id: string;
  purchaseBillLineId: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  hsnCode: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
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
  effectiveUnitCost: number;
  supplyCategory: SupplyCategory;
}

export interface DebitNoteHeaderRow {
  id: string;
  outletId: string;
  supplierId: string;
  purchaseBillId: string;
  documentNumber: string;
  grandTotal: number;
  status: 'issued' | 'void';
  restock: boolean;
  [column: string]: unknown;
}

/** A bill line with how much of it has already been returned. */
export interface ReturnableLineRow {
  id: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  hsnCode: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  taxRatePercent: string;
  cessRatePercent: string;
  effectiveUnitCost: number;
  supplyCategory: SupplyCategory;
  returnedQuantity: number;
}

const HEADER_COLUMNS = `
  d.id, d.outlet_id AS "outletId", d.supplier_id AS "supplierId",
  d.purchase_bill_id AS "purchaseBillId", d.original_document_number AS "originalDocumentNumber",
  d.series_id AS "seriesId", d.sequence_no AS "sequenceNo", d.document_number AS "documentNumber",
  d.document_date AS "documentDate", d.fy_start_year AS "fyStartYear",
  d.supplier_gstin AS "supplierGstin", d.supplier_state_code AS "supplierStateCode",
  d.place_of_supply_state_code AS "placeOfSupplyStateCode", d.tax_mode AS "taxMode",
  d.supply_type AS "supplyType", d.prices_include_tax AS "pricesIncludeTax",
  d.round_off_enabled AS "roundOffEnabled", d.gross_amount AS "grossAmount",
  d.line_discount_total AS "lineDiscountTotal", d.bill_discount_amount AS "billDiscountAmount",
  d.taxable_amount AS "taxableAmount", d.total_cgst AS "totalCgst", d.total_sgst AS "totalSgst",
  d.total_igst AS "totalIgst", d.total_cess AS "totalCess", d.total_tax AS "totalTax",
  d.sub_total AS "subTotal", d.round_off AS "roundOff", d.grand_total AS "grandTotal",
  d.tax_summary AS "taxSummary", d.hsn_summary AS "hsnSummary", d.reason_code AS "reasonCode",
  d.restock, d.is_reverse_charge AS "isReverseCharge",
  d.notes, d.status, d.issued_at AS "issuedAt", d.issued_by AS "issuedBy",
  d.void_reason AS "voidReason", d.voided_at AS "voidedAt", d.voided_by AS "voidedBy",
  d.created_at AS "createdAt"`;

const LINE_COLUMNS = `
  id, purchase_bill_line_id AS "purchaseBillLineId", line_no AS "lineNo", item_id AS "itemId",
  item_name AS "itemName", hsn_code AS "hsnCode", unit, quantity, unit_price AS "unitPrice",
  gross_amount AS "grossAmount", line_discount AS "lineDiscount", taxable_amount AS "taxableAmount",
  tax_rate_percent AS "taxRatePercent", cess_rate_percent AS "cessRatePercent",
  cgst, sgst, igst, cess, line_total AS "lineTotal", effective_unit_cost AS "effectiveUnitCost",
  supply_category AS "supplyCategory"`;

export const debitNotesRepository = {
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM debit_notes WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  /**
   * Bill lines with the quantity already returned on issued debit notes.
   *
   * Two debit notes raised at the same time must not both pass the "not more than was
   * bought" check. That is guaranteed by the caller locking the bill header, not by a
   * lock on these rows: purchase_bill_lines is immutable, so the runtime role has no
   * UPDATE privilege on it and `FOR UPDATE OF l` is refused.
   */
  returnableLines(tx: Tx, billId: string, _lockedByHeader = false): Promise<ReturnableLineRow[]> {
    return tx.many<ReturnableLineRow>(
      `SELECT l.id, l.line_no AS "lineNo", l.item_id AS "itemId", l.item_name AS "itemName",
              l.hsn_code AS "hsnCode", l.unit, l.quantity, l.unit_price AS "unitPrice",
              l.tax_rate_percent AS "taxRatePercent", l.cess_rate_percent AS "cessRatePercent",
              l.effective_unit_cost AS "effectiveUnitCost", l.supply_category AS "supplyCategory",
              COALESCE((SELECT SUM(dl.quantity) FROM debit_note_lines dl
                        JOIN debit_notes d ON d.id = dl.debit_note_id
                        WHERE dl.purchase_bill_line_id = l.id AND d.status = 'issued'), 0)
                AS "returnedQuantity"
       FROM purchase_bill_lines l
       WHERE l.purchase_bill_id = $1
       ORDER BY l.line_no`,
      [billId],
    );
  },

  async insertHeader(tx: Tx, h: DebitNoteHeaderInsert): Promise<void> {
    const t = h.totals;
    await tx.query(
      `INSERT INTO debit_notes (
         id, tenant_id, outlet_id, supplier_id, purchase_bill_id, original_document_number,
         series_id, sequence_no, document_number, document_date, fy_start_year,
         supplier_gstin, supplier_state_code, place_of_supply_state_code,
         tax_mode, supply_type, prices_include_tax, round_off_enabled,
         gross_amount, line_discount_total, bill_discount_amount, taxable_amount,
         total_cgst, total_sgst, total_igst, total_cess, total_tax, sub_total, round_off,
         grand_total, tax_summary, hsn_summary, reason_code, restock, notes, status, issued_at, issued_by,
         is_reverse_charge)
       VALUES (
         $1, app.current_tenant_id(), $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $17,
         $18, $19, $20, $21,
         $22, $23, $24, $25, $26, $27, $28,
         $29, $30, $31, $32, $33, $34, 'issued', $35, $36, $37)`,
      [
        h.id,
        h.outletId,
        h.supplierId,
        h.purchaseBillId,
        h.originalDocumentNumber,
        h.seriesId,
        h.sequenceNo,
        h.documentNumber,
        h.documentDate,
        h.fyStartYear,
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
        h.restock,
        h.notes,
        h.issuedAt,
        h.issuedBy,
        t.isReverseCharge,
      ],
    );
  },

  async insertLines(
    tx: Tx,
    noteId: string,
    outletId: string,
    documentDate: string,
    lines: readonly DebitNoteLineInsert[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO debit_note_lines (id, tenant_id, debit_note_id, purchase_bill_line_id, outlet_id,
         document_date, line_no, item_id, item_name, hsn_code, unit, quantity, unit_price,
         gross_amount, line_discount, taxable_amount, tax_rate_percent, cess_rate_percent,
         cgst, sgst, igst, cess, line_total, effective_unit_cost, supply_category)
       SELECT l.id, app.current_tenant_id(), $1, l."purchaseBillLineId", $2, $3, l."lineNo",
              l."itemId", l."itemName", l."hsnCode", l.unit, l.quantity, l."unitPrice",
              l."grossAmount", l."lineDiscount", l."taxableAmount", l."taxRatePercent",
              l."cessRatePercent", l.cgst, l.sgst, l.igst, l.cess, l."lineTotal",
              l."effectiveUnitCost", l."supplyCategory"
       FROM jsonb_to_recordset($4::jsonb) AS l(
         id uuid, "purchaseBillLineId" uuid, "lineNo" int, "itemId" uuid, "itemName" text,
         "hsnCode" text, unit text, quantity bigint, "unitPrice" bigint, "grossAmount" bigint,
         "lineDiscount" bigint, "taxableAmount" bigint, "taxRatePercent" numeric,
         "cessRatePercent" numeric, cgst bigint, sgst bigint, igst bigint, cess bigint,
         "lineTotal" bigint, "effectiveUnitCost" bigint, "supplyCategory" text)`,
      [noteId, outletId, documentDate, JSON.stringify(lines)],
    );
  },

  findHeader(tx: Tx, id: string, forUpdate = false): Promise<DebitNoteHeaderRow | undefined> {
    return tx.one<DebitNoteHeaderRow>(
      `SELECT ${HEADER_COLUMNS} FROM debit_notes d WHERE d.id = $1 ${
        forUpdate ? 'FOR UPDATE OF d' : ''
      }`,
      [id],
    );
  },

  findLines(tx: Tx, noteId: string) {
    return tx.many(
      `SELECT ${LINE_COLUMNS} FROM debit_note_lines WHERE debit_note_id = $1 ORDER BY line_no`,
      [noteId],
    );
  },

  list(
    tx: Tx,
    filter: {
      supplierId: string | undefined;
      purchaseBillId: string | undefined;
      from: string | undefined;
      to: string | undefined;
    },
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ) {
    return tx.many<{
      id: string;
      documentNumber: string;
      documentDate: string;
      supplierId: string;
      supplierName: string;
      grandTotal: number;
      status: string;
    }>(
      `SELECT d.id, d.document_number AS "documentNumber", d.document_date AS "documentDate",
              d.supplier_id AS "supplierId", s.name AS "supplierName",
              d.grand_total AS "grandTotal", d.status
       FROM debit_notes d
       JOIN suppliers s ON s.id = d.supplier_id
       WHERE ($1::uuid IS NULL OR d.supplier_id = $1)
         AND ($2::uuid IS NULL OR d.purchase_bill_id = $2)
         AND ($3::date IS NULL OR d.document_date >= $3)
         AND ($4::date IS NULL OR d.document_date <= $4)
         AND ($5::uuid[] IS NULL OR d.outlet_id = ANY($5::uuid[]))
         AND ($6::date IS NULL OR (d.document_date, d.id) < ($6::date, $7::uuid))
       ORDER BY d.document_date DESC, d.id DESC
       LIMIT $8`,
      [
        filter.supplierId ?? null,
        filter.purchaseBillId ?? null,
        filter.from ?? null,
        filter.to ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async markVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      `UPDATE debit_notes SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3
       WHERE id = $1`,
      [id, reason, userId],
    );
  },
};
