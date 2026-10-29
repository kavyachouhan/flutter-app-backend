import { jsonParam, likeContains } from '../../db/sql.js';
import type { Tx } from '../../db/tx.js';
import type { Discount, SupplyCategory, TaxInvoiceResult } from '../../domain/tax/types.js';
import type { Cursor } from '../../lib/pagination.js';
import type { TermsSnapshot } from '../terms/terms.schemas.js';
import type { EstimateStatus } from './estimates.schemas.js';

export type EstimateConversionType = 'sales_order' | 'invoice';

export interface EstimateRow {
  id: string;
  outletId: string;
  documentNumber: string;
  documentDate: string;
  validUntil: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  placeOfSupplyStateCode: string | null;
  taxMode: string;
  supplyType: string;
  pricesIncludeTax: boolean;
  roundOffEnabled: boolean;
  isReverseCharge: boolean;
  grossAmount: number;
  lineDiscountTotal: number;
  billDiscount: Discount | null;
  billDiscountAmount: number;
  billDiscountReason: string | null;
  additionalCharges: unknown;
  taxableCharges: number;
  nonTaxableCharges: number;
  taxableAmount: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
  totalTax: number;
  taxSummary: unknown;
  subTotal: number;
  roundOff: number;
  grandTotal: number;
  notes: string | null;
  customFields: Record<string, string> | null;
  attachments: unknown;
  termsId: string | null;
  termsSnapshot: TermsSnapshot | null;
  status: EstimateStatus;
  convertedToType: EstimateConversionType | null;
  convertedToId: string | null;
  convertedAt: Date | null;
  cancelledReason: string | null;
  createdAt: Date;
}

export interface EstimateLineRow {
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
  supplyCategory: SupplyCategory;
}

export type EstimateLineWrite = EstimateLineRow;

export interface EstimateHeaderWrite {
  id: string;
  outletId: string;
  seriesId: string | null;
  sequenceNo: number | null;
  documentNumber: string;
  fyStartYear: number;
  documentDate: string;
  validUntil: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  placeOfSupplyStateCode: string | null;
  pricesIncludeTax: boolean;
  roundOffEnabled: boolean;
  isReverseCharge: boolean;
  totals: TaxInvoiceResult;
  billDiscount: Discount | null;
  billDiscountReason: string | null;
  additionalCharges: readonly unknown[];
  notes: string | null;
  customFields: Record<string, string> | null;
  attachments: readonly unknown[];
  termsId: string | null;
  termsSnapshot: TermsSnapshot | null;
  createdBy: string;
}

export type EstimateHeaderUpdate = Omit<
  EstimateHeaderWrite,
  'seriesId' | 'sequenceNo' | 'documentNumber' | 'fyStartYear' | 'createdBy'
>;

export interface EstimateSummary {
  all: number;
  open: number;
  closed: number;
}

const ESTIMATE_COLUMNS = `
  e.id, e.outlet_id AS "outletId", e.document_number AS "documentNumber",
  e.document_date AS "documentDate", e.valid_until AS "validUntil",
  e.customer_id AS "customerId", e.customer_name AS "customerName", e.customer_phone AS "customerPhone",
  e.place_of_supply_state_code AS "placeOfSupplyStateCode", e.tax_mode AS "taxMode",
  e.supply_type AS "supplyType", e.prices_include_tax AS "pricesIncludeTax",
  e.round_off_enabled AS "roundOffEnabled", e.is_reverse_charge AS "isReverseCharge",
  e.gross_amount AS "grossAmount",
  e.line_discount_total AS "lineDiscountTotal", e.bill_discount AS "billDiscount",
  e.bill_discount_amount AS "billDiscountAmount", e.bill_discount_reason AS "billDiscountReason",
  e.additional_charges AS "additionalCharges", e.taxable_charges AS "taxableCharges",
  e.non_taxable_charges AS "nonTaxableCharges", e.taxable_amount AS "taxableAmount",
  e.total_cgst AS "totalCgst", e.total_sgst AS "totalSgst", e.total_igst AS "totalIgst",
  e.total_cess AS "totalCess", e.total_tax AS "totalTax", e.tax_summary AS "taxSummary",
  e.sub_total AS "subTotal", e.round_off AS "roundOff", e.grand_total AS "grandTotal",
  e.notes, e.custom_fields AS "customFields", e.attachments,
  e.terms_id AS "termsId", e.terms_snapshot AS "termsSnapshot", e.status,
  e.converted_to_type AS "convertedToType", e.converted_to_id AS "convertedToId",
  e.converted_at AS "convertedAt", e.cancelled_reason AS "cancelledReason",
  e.created_at AS "createdAt"`;

const LINE_COLUMNS = `
  id, line_no AS "lineNo", item_id AS "itemId", item_name AS "itemName", hsn_code AS "hsnCode", unit,
  quantity, unit_price AS "unitPrice", discount,
  gross_amount AS "grossAmount", line_discount AS "lineDiscount", bill_discount_share AS "billDiscountShare",
  taxable_amount AS "taxableAmount", tax_rate_percent AS "taxRatePercent", cess_rate_percent AS "cessRatePercent",
  cgst, sgst, igst, cess, line_total AS "lineTotal", supply_category AS "supplyCategory"`;

const LINE_RECORDSET = `
  id uuid, "lineNo" int, "itemId" uuid, "itemName" text, "hsnCode" text, unit text, quantity bigint,
  "unitPrice" bigint, discount jsonb, "grossAmount" bigint, "lineDiscount" bigint, "billDiscountShare" bigint,
  "taxableAmount" bigint, "taxRatePercent" numeric, "cessRatePercent" numeric, cgst bigint, sgst bigint,
  igst bigint, cess bigint, "lineTotal" bigint, "supplyCategory" text`;

export const estimatesRepository = {
  /** Includes deleted estimates, so a replayed create of a deleted one is not re-created. */
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM estimates WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  /** `forUpdate` serialises two conversions (or a conversion and an edit) of one estimate. */
  find(tx: Tx, id: string, forUpdate = false): Promise<EstimateRow | undefined> {
    return tx.one<EstimateRow>(
      `SELECT ${ESTIMATE_COLUMNS} FROM estimates e
       WHERE e.id = $1 AND e.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF e' : ''}`,
      [id],
    );
  },

  findLines(tx: Tx, estimateId: string): Promise<EstimateLineRow[]> {
    return tx.many<EstimateLineRow>(
      `SELECT ${LINE_COLUMNS} FROM estimate_lines WHERE estimate_id = $1 ORDER BY line_no`,
      [estimateId],
    );
  },

  async insertHeader(tx: Tx, h: EstimateHeaderWrite): Promise<void> {
    const t = h.totals;
    await tx.query(
      `INSERT INTO estimates (
         id, tenant_id, outlet_id, series_id, sequence_no, document_number, document_date, fy_start_year,
         valid_until, customer_id, customer_name, customer_phone, place_of_supply_state_code, tax_mode,
         supply_type, prices_include_tax, round_off_enabled, is_reverse_charge, gross_amount,
         line_discount_total, bill_discount, bill_discount_amount, bill_discount_reason,
         additional_charges, taxable_charges, non_taxable_charges, taxable_amount, total_cgst,
         total_sgst, total_igst, total_cess, total_tax, sub_total, round_off, grand_total,
         tax_summary, hsn_summary, notes, custom_fields, attachments, terms_id, terms_snapshot,
         status, created_by)
       VALUES (
         $1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18,
         $19, $20, $21, $22,
         $23::jsonb, $24, $25, $26, $27,
         $28, $29, $30, $31, $32, $33, $34,
         $35, $36, $37, $38, $39::jsonb, $40, $41,
         'open', $42)`,
      [
        h.id,
        h.outletId,
        h.seriesId,
        h.sequenceNo,
        h.documentNumber,
        h.documentDate,
        h.fyStartYear,
        h.validUntil,
        h.customerId,
        h.customerName,
        h.customerPhone,
        h.placeOfSupplyStateCode,
        t.mode,
        t.supplyType,
        h.pricesIncludeTax,
        h.roundOffEnabled,
        h.isReverseCharge,
        t.grossAmount,
        t.totalLineDiscount,
        jsonParam(h.billDiscount),
        t.billDiscount,
        h.billDiscountReason,
        JSON.stringify(h.additionalCharges),
        t.taxableCharges,
        t.nonTaxableCharges,
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
        h.notes,
        jsonParam(h.customFields),
        JSON.stringify(h.attachments),
        h.termsId,
        jsonParam(h.termsSnapshot),
        h.createdBy,
      ],
    );
  },

  /** Replaces every editable header field; number, series and creator never change. */
  async updateHeader(tx: Tx, h: EstimateHeaderUpdate): Promise<void> {
    const t = h.totals;
    await tx.query(
      `UPDATE estimates SET
         document_date = $2, valid_until = $3, customer_id = $4, customer_name = $5, customer_phone = $6,
         place_of_supply_state_code = $7, tax_mode = $8, supply_type = $9, prices_include_tax = $10,
         round_off_enabled = $11, is_reverse_charge = $12, gross_amount = $13, line_discount_total = $14,
         bill_discount = $15, bill_discount_amount = $16, bill_discount_reason = $17,
         additional_charges = $18::jsonb, taxable_charges = $19, non_taxable_charges = $20,
         taxable_amount = $21, total_cgst = $22, total_sgst = $23, total_igst = $24, total_cess = $25,
         total_tax = $26, sub_total = $27, round_off = $28, grand_total = $29, tax_summary = $30,
         hsn_summary = $31, notes = $32, custom_fields = $33, attachments = $34::jsonb,
         terms_id = $35, terms_snapshot = $36
       WHERE id = $1`,
      [
        h.id,
        h.documentDate,
        h.validUntil,
        h.customerId,
        h.customerName,
        h.customerPhone,
        h.placeOfSupplyStateCode,
        t.mode,
        t.supplyType,
        h.pricesIncludeTax,
        h.roundOffEnabled,
        h.isReverseCharge,
        t.grossAmount,
        t.totalLineDiscount,
        jsonParam(h.billDiscount),
        t.billDiscount,
        h.billDiscountReason,
        JSON.stringify(h.additionalCharges),
        t.taxableCharges,
        t.nonTaxableCharges,
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
        h.notes,
        jsonParam(h.customFields),
        JSON.stringify(h.attachments),
        h.termsId,
        jsonParam(h.termsSnapshot),
      ],
    );
  },

  async insertLines(
    tx: Tx,
    estimateId: string,
    lines: readonly EstimateLineWrite[],
  ): Promise<void> {
    if (lines.length === 0) return;
    await tx.query(
      `INSERT INTO estimate_lines (id, tenant_id, estimate_id, line_no, item_id, item_name, hsn_code,
         unit, quantity, unit_price, discount, gross_amount, line_discount, bill_discount_share,
         taxable_amount, tax_rate_percent, cess_rate_percent, cgst, sgst, igst, cess, line_total,
         supply_category)
       SELECT l.id, app.current_tenant_id(), $1, l."lineNo", l."itemId", l."itemName", l."hsnCode",
              l.unit, l.quantity, l."unitPrice", l.discount, l."grossAmount", l."lineDiscount",
              l."billDiscountShare", l."taxableAmount", l."taxRatePercent", l."cessRatePercent",
              l.cgst, l.sgst, l.igst, l.cess, l."lineTotal", l."supplyCategory"
       FROM jsonb_to_recordset($2::jsonb) AS l(${LINE_RECORDSET})`,
      [estimateId, JSON.stringify(lines)],
    );
  },

  /** An estimate has no fulfilment to protect, so an edit simply rewrites the lines. */
  async deleteLines(tx: Tx, estimateId: string): Promise<void> {
    await tx.query('DELETE FROM estimate_lines WHERE estimate_id = $1', [estimateId]);
  },

  async markConverted(
    tx: Tx,
    estimateId: string,
    type: EstimateConversionType,
    targetId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE estimates
       SET status = 'converted', converted_to_type = $2, converted_to_id = $3, converted_at = now()
       WHERE id = $1`,
      [estimateId, type, targetId],
    );
  },

  /** Carries the estimate's T&C, as it read when quoted, onto the order raised from it. */
  async copyTermsToSalesOrder(
    tx: Tx,
    salesOrderId: string,
    termsId: string | null,
    snapshot: TermsSnapshot | null,
  ): Promise<void> {
    if (!termsId) return;
    await tx.query('UPDATE sales_orders SET terms_id = $2, terms_snapshot = $3 WHERE id = $1', [
      salesOrderId,
      termsId,
      jsonParam(snapshot),
    ]);
  },

  async close(tx: Tx, estimateId: string): Promise<void> {
    await tx.query("UPDATE estimates SET status = 'closed' WHERE id = $1", [estimateId]);
  },

  async cancel(tx: Tx, estimateId: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE estimates SET status = 'cancelled', cancelled_reason = $2, cancelled_at = now()
       WHERE id = $1`,
      [estimateId, reason],
    );
  },

  async softDelete(tx: Tx, estimateId: string): Promise<void> {
    await tx.query('UPDATE estimates SET deleted_at = now() WHERE id = $1', [estimateId]);
  },

  /** The number of the document an estimate became, for showing "Converted to SO/26-27/0001". */
  async convertedDocumentNumber(
    tx: Tx,
    type: EstimateConversionType,
    id: string,
  ): Promise<string | null> {
    const table = type === 'sales_order' ? 'sales_orders' : 'invoices';
    const row = await tx.one<{ documentNumber: string }>(
      `SELECT document_number AS "documentNumber" FROM ${table} WHERE id = $1`,
      [id],
    );
    return row?.documentNumber ?? null;
  },

  list(
    tx: Tx,
    filter: {
      status: string | undefined;
      customerId: string | undefined;
      outletId: string | undefined;
      q: string | undefined;
    },
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<EstimateRow[]> {
    return tx.many<EstimateRow>(
      `SELECT ${ESTIMATE_COLUMNS} FROM estimates e
       WHERE e.deleted_at IS NULL
         AND ($1::text IS NULL OR ($1 = 'open' AND e.status = 'open')
              OR ($1 = 'closed' AND e.status <> 'open'))
         AND ($2::uuid IS NULL OR e.customer_id = $2)
         AND ($3::uuid IS NULL OR e.outlet_id = $3)
         AND ($4::uuid[] IS NULL OR e.outlet_id = ANY($4::uuid[]))
         AND ($5::date IS NULL OR (e.document_date, e.id) < ($5::date, $6::uuid))
         AND ($8::text IS NULL OR e.document_number ILIKE $8 OR e.customer_name ILIKE $8
              OR e.customer_phone ILIKE $8)
       ORDER BY e.document_date DESC, e.id DESC
       LIMIT $7`,
      [
        filter.status && filter.status !== 'all' ? filter.status : null,
        filter.customerId ?? null,
        filter.outletId ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
        filter.q ? likeContains(filter.q) : null,
      ],
    );
  },

  /** Counts for the filter chips. */
  async summary(
    tx: Tx,
    outletId: string | undefined,
    restrictTo: readonly string[] | null,
  ): Promise<EstimateSummary> {
    const row = await tx.one<EstimateSummary>(
      `SELECT count(*)::int AS "all",
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status <> 'open')::int AS closed
       FROM estimates
       WHERE deleted_at IS NULL
         AND ($1::uuid IS NULL OR outlet_id = $1)
         AND ($2::uuid[] IS NULL OR outlet_id = ANY($2::uuid[]))`,
      [outletId ?? null, restrictTo ? [...restrictTo] : null],
    );
    return row ?? { all: 0, open: 0, closed: 0 };
  },
};
