import type { Tx } from '../../db/tx.js';
import { jsonParam } from '../../db/sql.js';
import type { AdditionalCharge, Discount, TaxInvoiceResult } from '../../domain/tax/types.js';
import type { Cursor } from '../../lib/pagination.js';

export interface InvoiceItemRow {
  id: string;
  name: string;
  hsnCode: string | null;
  unit: string;
  trackStock: boolean;
}

export interface InvoiceHeaderInsert {
  id: string;
  outletId: string;
  counterId: string | null;
  deviceId: string;
  seriesId: string;
  sequenceNo: number;
  documentNumber: string;
  documentDate: string;
  fyStartYear: number;
  customerId: string | null;
  customerName: string | null;
  customerGstin: string | null;
  supplierGstin: string | null;
  supplierStateCode: string;
  placeOfSupplyStateCode: string | null;
  pricesIncludeTax: boolean;
  roundOffEnabled: boolean;
  totals: TaxInvoiceResult;
  billDiscount: Discount | null;
  additionalCharges: readonly AdditionalCharge[];
  notes: string | null;
  customFields: Record<string, string> | null;
  issuedAt: string;
  issuedBy: string;
}

export interface InvoiceLineInsert {
  id: string;
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
  billDiscountShare: number;
  taxableAmount: number;
  taxRatePercent: number;
  cessRatePercent: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  lineTotal: number;
  /**
   * Moving-average cost at the moment of sale. Null when the item has never
   * been purchased through the system, so margin reads as unknown rather
   * than as pure profit.
   */
  cogsAmount: number | null;
}

export interface InvoiceHeaderRow {
  id: string;
  outletId: string;
  counterId: string | null;
  deviceId: string;
  seriesId: string;
  sequenceNo: number;
  documentNumber: string;
  documentDate: string;
  customerId: string | null;
  customerName: string | null;
  grandTotal: number;
  status: 'issued' | 'void';
  amountPaid: number;
  [column: string]: unknown;
}

export interface InvoiceSummaryRow {
  id: string;
  outletId: string;
  documentNumber: string;
  documentDate: string;
  customerId: string | null;
  customerName: string | null;
  grandTotal: number;
  amountPaid: number;
  status: 'issued' | 'void';
}

const AMOUNT_PAID = `COALESCE((
  SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
  WHERE pa.invoice_id = i.id AND p.status = 'issued'), 0)`;

const HEADER_COLUMNS = `
  i.id, i.outlet_id AS "outletId", i.counter_id AS "counterId", i.device_id AS "deviceId", i.series_id AS "seriesId",
  i.sequence_no AS "sequenceNo", i.document_number AS "documentNumber", i.document_date AS "documentDate",
  i.fy_start_year AS "fyStartYear", i.customer_id AS "customerId", i.customer_name AS "customerName",
  i.customer_gstin AS "customerGstin", i.supplier_gstin AS "supplierGstin", i.supplier_state_code AS "supplierStateCode",
  i.place_of_supply_state_code AS "placeOfSupplyStateCode", i.tax_mode AS "taxMode", i.supply_type AS "supplyType",
  i.prices_include_tax AS "pricesIncludeTax", i.round_off_enabled AS "roundOffEnabled",
  i.gross_amount AS "grossAmount", i.line_discount_total AS "lineDiscountTotal", i.bill_discount AS "billDiscount",
  i.bill_discount_amount AS "billDiscountAmount", i.taxable_amount AS "taxableAmount", i.total_cgst AS "totalCgst",
  i.total_sgst AS "totalSgst", i.total_igst AS "totalIgst", i.total_cess AS "totalCess", i.total_tax AS "totalTax",
  i.taxable_charges AS "taxableCharges", i.non_taxable_charges AS "nonTaxableCharges",
  i.additional_charges AS "additionalCharges", i.sub_total AS "subTotal", i.round_off AS "roundOff",
  i.grand_total AS "grandTotal", i.tax_summary AS "taxSummary", i.hsn_summary AS "hsnSummary", i.notes, i.status,
  i.issued_at AS "issuedAt", i.issued_by AS "issuedBy", i.void_reason AS "voidReason", i.voided_at AS "voidedAt",
  i.voided_by AS "voidedBy", i.print_count AS "printCount", i.printed_at AS "printedAt", i.created_at AS "createdAt",
  i.custom_fields AS "customFields", ${AMOUNT_PAID} AS "amountPaid"`;

const LINE_COLUMNS = `
  id, line_no AS "lineNo", item_id AS "itemId", item_name AS "itemName", hsn_code AS "hsnCode", unit, quantity,
  unit_price AS "unitPrice", discount, gross_amount AS "grossAmount", line_discount AS "lineDiscount",
  bill_discount_share AS "billDiscountShare", taxable_amount AS "taxableAmount", tax_rate_percent AS "taxRatePercent",
  cess_rate_percent AS "cessRatePercent", cgst, sgst, igst, cess, line_total AS "lineTotal",
  cogs_amount AS "cogsAmount"`;

export interface InvoiceListFilter {
  from: string | undefined;
  to: string | undefined;
  status: string | undefined;
  customerId: string | undefined;
  outletId: string | undefined;
}

export const invoicesRepository = {
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM invoices WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  /** Deliberately includes deleted items: see createInvoice. */
  findItems(tx: Tx, ids: readonly string[]): Promise<InvoiceItemRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.many<InvoiceItemRow>(
      'SELECT id, name, hsn_code AS "hsnCode", unit, track_stock AS "trackStock" FROM items WHERE id = ANY($1::uuid[])',
      [[...ids]],
    );
  },

  async insertHeader(tx: Tx, h: InvoiceHeaderInsert): Promise<void> {
    const t = h.totals;
    await tx.query(
      `INSERT INTO invoices (
         id, tenant_id, outlet_id, counter_id, device_id, series_id, sequence_no, document_number, document_date,
         fy_start_year, customer_id, customer_name, customer_gstin, supplier_gstin, supplier_state_code,
         place_of_supply_state_code, tax_mode, supply_type, prices_include_tax, round_off_enabled,
         gross_amount, line_discount_total, bill_discount, bill_discount_amount, taxable_amount,
         total_cgst, total_sgst, total_igst, total_cess, total_tax, taxable_charges, non_taxable_charges,
         additional_charges, sub_total, round_off, grand_total, tax_summary, hsn_summary, notes, status,
         issued_at, issued_by, custom_fields)
       VALUES (
         $1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19,
         $20, $21, $22, $23, $24,
         $25, $26, $27, $28, $29, $30, $31,
         $32, $33, $34, $35, $36, $37, $38, 'issued',
         $39, $40, $41)`,
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
        jsonParam(h.billDiscount),
        t.billDiscount,
        t.taxableAmount,
        t.totalCgst,
        t.totalSgst,
        t.totalIgst,
        t.totalCess,
        t.totalTax,
        t.taxableCharges,
        t.nonTaxableCharges,
        JSON.stringify(h.additionalCharges),
        t.subTotal,
        t.roundOff,
        t.grandTotal,
        JSON.stringify(t.taxSummary),
        JSON.stringify(t.hsnSummary),
        h.notes,
        h.issuedAt,
        h.issuedBy,
        jsonParam(h.customFields),
      ],
    );
  },

  /**
   * `outletId` and `documentDate` are copied down from the header so the
   * item-wise and category-wise sales reports can filter lines without joining
   * invoices. They are arguments rather than per-line fields because they are
   * the same for every line of one document.
   */
  async insertLines(
    tx: Tx,
    invoiceId: string,
    outletId: string,
    documentDate: string,
    lines: readonly InvoiceLineInsert[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO invoice_lines (id, tenant_id, invoice_id, outlet_id, document_date, line_no, item_id, item_name,
         hsn_code, unit, quantity, unit_price, discount, gross_amount, line_discount, bill_discount_share,
         taxable_amount, tax_rate_percent, cess_rate_percent, cgst, sgst, igst, cess, line_total, cogs_amount)
       SELECT l.id, app.current_tenant_id(), $1, $2, $3, l."lineNo", l."itemId", l."itemName",
              l."hsnCode", l.unit, l.quantity, l."unitPrice", l.discount, l."grossAmount", l."lineDiscount",
              l."billDiscountShare", l."taxableAmount", l."taxRatePercent", l."cessRatePercent", l.cgst, l.sgst,
              l.igst, l.cess, l."lineTotal", l."cogsAmount"
       FROM jsonb_to_recordset($4::jsonb) AS l(
         id uuid, "lineNo" int, "itemId" uuid, "itemName" text, "hsnCode" text, unit text, quantity bigint,
         "unitPrice" bigint, discount jsonb, "grossAmount" bigint, "lineDiscount" bigint, "billDiscountShare" bigint,
         "taxableAmount" bigint, "taxRatePercent" numeric, "cessRatePercent" numeric, cgst bigint, sgst bigint,
         igst bigint, cess bigint, "lineTotal" bigint, "cogsAmount" bigint)`,
      [invoiceId, outletId, documentDate, JSON.stringify(lines)],
    );
  },

  findHeader(tx: Tx, id: string, forUpdate = false): Promise<InvoiceHeaderRow | undefined> {
    return tx.one<InvoiceHeaderRow>(
      `SELECT ${HEADER_COLUMNS} FROM invoices i WHERE i.id = $1 ${forUpdate ? 'FOR UPDATE OF i' : ''}`,
      [id],
    );
  },

  findLines(tx: Tx, invoiceId: string) {
    return tx.many(
      `SELECT ${LINE_COLUMNS} FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoiceId],
    );
  },

  list(
    tx: Tx,
    filter: InvoiceListFilter,
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<InvoiceSummaryRow[]> {
    return tx.many<InvoiceSummaryRow>(
      `SELECT i.id, i.outlet_id AS "outletId", i.document_number AS "documentNumber", i.document_date AS "documentDate",
              i.customer_id AS "customerId", i.customer_name AS "customerName", i.grand_total AS "grandTotal",
              ${AMOUNT_PAID} AS "amountPaid", i.status
       FROM invoices i
       WHERE ($1::date IS NULL OR i.document_date >= $1)
         AND ($2::date IS NULL OR i.document_date <= $2)
         AND ($3::text IS NULL OR i.status = $3)
         AND ($4::uuid IS NULL OR i.customer_id = $4)
         AND ($5::uuid IS NULL OR i.outlet_id = $5)
         AND ($6::uuid[] IS NULL OR i.outlet_id = ANY($6::uuid[]))
         AND ($7::date IS NULL OR (i.document_date, i.id) < ($7::date, $8::uuid))
       ORDER BY i.document_date DESC, i.id DESC
       LIMIT $9`,
      [
        filter.from ?? null,
        filter.to ?? null,
        filter.status ?? null,
        filter.customerId ?? null,
        filter.outletId ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async markVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      "UPDATE invoices SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3 WHERE id = $1",
      [id, reason, userId],
    );
  },

  async markPrinted(tx: Tx, id: string): Promise<void> {
    await tx.query(
      'UPDATE invoices SET print_count = print_count + 1, printed_at = now() WHERE id = $1',
      [id],
    );
  },
};
