import { jsonParam, likeContains } from '../../db/sql.js';
import type { Tx } from '../../db/tx.js';
import type { Discount, SupplyCategory, TaxInvoiceResult } from '../../domain/tax/types.js';
import type { Cursor } from '../../lib/pagination.js';
import type { TermsSnapshot } from '../terms/terms.schemas.js';

export type SaleOrderStatus = 'open' | 'partial' | 'closed' | 'cancelled';

export interface SaleOrderRow {
  id: string;
  outletId: string;
  documentNumber: string;
  documentDate: string;
  dueDate: string | null;
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
  taxableAmount: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
  totalTax: number;
  additionalCharges: unknown;
  taxableCharges: number;
  nonTaxableCharges: number;
  taxSummary: unknown;
  subTotal: number;
  roundOff: number;
  grandTotal: number;
  advanceAmount: number;
  advanceRefunded: number;
  advancePaymentId: string | null;
  paymentMode: string | null;
  notes: string | null;
  customFields: Record<string, string> | null;
  attachments: unknown;
  termsId: string | null;
  termsSnapshot: TermsSnapshot | null;
  status: SaleOrderStatus;
  closedManually: boolean;
  cancelledReason: string | null;
  createdAt: Date;
}

export interface SaleOrderLineRow {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemName: string;
  hsnCode: string | null;
  unit: string | null;
  quantity: number;
  quantityFulfilled: number;
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

export interface SaleOrderHeaderWrite {
  id: string;
  outletId: string;
  seriesId: string | null;
  sequenceNo: number | null;
  documentNumber: string;
  fyStartYear: number;
  documentDate: string;
  dueDate: string | null;
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
  advanceAmount: number;
  advancePaymentId: string | null;
  paymentMode: string | null;
  notes: string | null;
  customFields: Record<string, string> | null;
  attachments: readonly unknown[];
  termsId: string | null;
  termsSnapshot: TermsSnapshot | null;
  createdBy: string;
}

export type SaleOrderHeaderUpdate = Omit<
  SaleOrderHeaderWrite,
  'seriesId' | 'sequenceNo' | 'documentNumber' | 'fyStartYear' | 'createdBy'
>;

export interface SaleOrderLineWrite {
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

export interface AdvanceState {
  /** Taken from the customer and not voided. */
  taken: number;
  /** Paid back out. */
  refunded: number;
  /** Counted toward invoices that still stand. */
  applied: number;
  /** What is left: taken less refunded less applied. */
  remaining: number;
}

export interface OrderInvoiceRow {
  id: string;
  documentNumber: string;
  documentDate: string;
  grandTotal: number;
  billDiscountAmount: number;
  status: 'issued' | 'void';
  amendsInvoiceId: string | null;
}

const ORDER_COLUMNS = `
  so.id, so.outlet_id AS "outletId", so.document_number AS "documentNumber",
  so.document_date AS "documentDate", so.due_date AS "dueDate",
  so.customer_id AS "customerId", so.customer_name AS "customerName", so.customer_phone AS "customerPhone",
  so.place_of_supply_state_code AS "placeOfSupplyStateCode", so.tax_mode AS "taxMode",
  so.supply_type AS "supplyType", so.prices_include_tax AS "pricesIncludeTax",
  so.round_off_enabled AS "roundOffEnabled", so.is_reverse_charge AS "isReverseCharge",
  so.gross_amount AS "grossAmount",
  so.line_discount_total AS "lineDiscountTotal", so.bill_discount AS "billDiscount",
  so.bill_discount_amount AS "billDiscountAmount", so.bill_discount_reason AS "billDiscountReason",
  so.taxable_amount AS "taxableAmount",
  so.total_cgst AS "totalCgst", so.total_sgst AS "totalSgst", so.total_igst AS "totalIgst",
  so.total_cess AS "totalCess", so.total_tax AS "totalTax",
  so.additional_charges AS "additionalCharges", so.taxable_charges AS "taxableCharges",
  so.non_taxable_charges AS "nonTaxableCharges", so.tax_summary AS "taxSummary",
  so.sub_total AS "subTotal",
  so.round_off AS "roundOff", so.grand_total AS "grandTotal", so.advance_amount AS "advanceAmount",
  so.advance_refunded AS "advanceRefunded",
  so.advance_payment_id AS "advancePaymentId", so.payment_mode AS "paymentMode", so.notes,
  so.custom_fields AS "customFields",
  so.attachments, so.terms_id AS "termsId", so.terms_snapshot AS "termsSnapshot", so.status,
  so.closed_manually AS "closedManually", so.cancelled_reason AS "cancelledReason",
  so.created_at AS "createdAt"`;

const LINE_COLUMNS = `
  id, line_no AS "lineNo", item_id AS "itemId", item_name AS "itemName", hsn_code AS "hsnCode", unit,
  quantity, quantity_fulfilled AS "quantityFulfilled", unit_price AS "unitPrice", discount,
  gross_amount AS "grossAmount", line_discount AS "lineDiscount", bill_discount_share AS "billDiscountShare",
  taxable_amount AS "taxableAmount", tax_rate_percent AS "taxRatePercent", cess_rate_percent AS "cessRatePercent",
  cgst, sgst, igst, cess, line_total AS "lineTotal", supply_category AS "supplyCategory"`;

const LINE_RECORDSET = `
  id uuid, "lineNo" int, "itemId" uuid, "itemName" text, "hsnCode" text, unit text, quantity bigint,
  "unitPrice" bigint, discount jsonb, "grossAmount" bigint, "lineDiscount" bigint, "billDiscountShare" bigint,
  "taxableAmount" bigint, "taxRatePercent" numeric, "cessRatePercent" numeric, cgst bigint, sgst bigint,
  igst bigint, cess bigint, "lineTotal" bigint, "supplyCategory" text`;

export const salesOrdersRepository = {
  /** Includes deleted orders, so a replayed create of a deleted order is not re-created. */
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM sales_orders WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  find(tx: Tx, id: string, forUpdate = false): Promise<SaleOrderRow | undefined> {
    return tx.one<SaleOrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM sales_orders so
       WHERE so.id = $1 AND so.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF so' : ''}`,
      [id],
    );
  },

  findLines(tx: Tx, orderId: string): Promise<SaleOrderLineRow[]> {
    return tx.many<SaleOrderLineRow>(
      `SELECT ${LINE_COLUMNS} FROM sales_order_lines WHERE sales_order_id = $1 ORDER BY line_no`,
      [orderId],
    );
  },

  /** Locked so two invoices against one order cannot both see the same fulfilled quantity. */
  lockLines(tx: Tx, orderId: string): Promise<SaleOrderLineRow[]> {
    return tx.many<SaleOrderLineRow>(
      `SELECT ${LINE_COLUMNS} FROM sales_order_lines WHERE sales_order_id = $1
       ORDER BY line_no FOR UPDATE`,
      [orderId],
    );
  },

  async insertHeader(tx: Tx, h: SaleOrderHeaderWrite): Promise<void> {
    const t = h.totals;
    await tx.query(
      `INSERT INTO sales_orders (
         id, tenant_id, outlet_id, series_id, sequence_no, document_number, document_date, fy_start_year,
         due_date, customer_id, customer_name, customer_phone, place_of_supply_state_code, tax_mode,
         supply_type, prices_include_tax, round_off_enabled, gross_amount, line_discount_total,
         bill_discount, bill_discount_amount, taxable_amount, total_cgst, total_sgst, total_igst,
         total_cess, total_tax, sub_total, round_off, grand_total, tax_summary, hsn_summary,
         advance_amount, advance_payment_id, payment_mode, notes, attachments, terms_id, terms_snapshot,
         status, created_by, is_reverse_charge, additional_charges, taxable_charges, non_taxable_charges,
         bill_discount_reason, custom_fields)
       VALUES (
         $1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24,
         $25, $26, $27, $28, $29, $30, $31,
         $32, $33, $34, $35, $36::jsonb, $37, $38,
         'open', $39, $40, $41::jsonb, $42, $43,
         $44, $45)`,
      [
        h.id,
        h.outletId,
        h.seriesId,
        h.sequenceNo,
        h.documentNumber,
        h.documentDate,
        h.fyStartYear,
        h.dueDate,
        h.customerId,
        h.customerName,
        h.customerPhone,
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
        t.subTotal,
        t.roundOff,
        t.grandTotal,
        JSON.stringify(t.taxSummary),
        JSON.stringify(t.hsnSummary),
        h.advanceAmount,
        h.advancePaymentId,
        h.paymentMode,
        h.notes,
        JSON.stringify(h.attachments),
        h.termsId,
        jsonParam(h.termsSnapshot),
        h.createdBy,
        h.isReverseCharge,
        JSON.stringify(h.additionalCharges),
        t.taxableCharges,
        t.nonTaxableCharges,
        h.billDiscountReason,
        jsonParam(h.customFields),
      ],
    );
  },

  /** Replaces every editable header field; number, series and creator never change. */
  async updateHeader(tx: Tx, h: SaleOrderHeaderUpdate): Promise<void> {
    const t = h.totals;
    await tx.query(
      `UPDATE sales_orders SET
         document_date = $2, due_date = $3, customer_id = $4, customer_name = $5, customer_phone = $6,
         place_of_supply_state_code = $7, tax_mode = $8, supply_type = $9, prices_include_tax = $10,
         round_off_enabled = $11, gross_amount = $12, line_discount_total = $13, bill_discount = $14,
         bill_discount_amount = $15, taxable_amount = $16, total_cgst = $17, total_sgst = $18,
         total_igst = $19, total_cess = $20, total_tax = $21, sub_total = $22, round_off = $23,
         grand_total = $24, tax_summary = $25, hsn_summary = $26, advance_amount = $27,
         advance_payment_id = $28, payment_mode = $29, notes = $30, attachments = $31::jsonb,
         terms_id = $32, terms_snapshot = $33, is_reverse_charge = $34, additional_charges = $35::jsonb,
         taxable_charges = $36, non_taxable_charges = $37, bill_discount_reason = $38, custom_fields = $39
       WHERE id = $1`,
      [
        h.id,
        h.documentDate,
        h.dueDate,
        h.customerId,
        h.customerName,
        h.customerPhone,
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
        t.subTotal,
        t.roundOff,
        t.grandTotal,
        JSON.stringify(t.taxSummary),
        JSON.stringify(t.hsnSummary),
        h.advanceAmount,
        h.advancePaymentId,
        h.paymentMode,
        h.notes,
        JSON.stringify(h.attachments),
        h.termsId,
        jsonParam(h.termsSnapshot),
        h.isReverseCharge,
        JSON.stringify(h.additionalCharges),
        t.taxableCharges,
        t.nonTaxableCharges,
        h.billDiscountReason,
        jsonParam(h.customFields),
      ],
    );
  },

  async insertLines(tx: Tx, orderId: string, lines: readonly SaleOrderLineWrite[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.query(
      `INSERT INTO sales_order_lines (id, tenant_id, sales_order_id, line_no, item_id, item_name, hsn_code,
         unit, quantity, unit_price, discount, gross_amount, line_discount, bill_discount_share,
         taxable_amount, tax_rate_percent, cess_rate_percent, cgst, sgst, igst, cess, line_total,
         supply_category)
       SELECT l.id, app.current_tenant_id(), $1, l."lineNo", l."itemId", l."itemName", l."hsnCode",
              l.unit, l.quantity, l."unitPrice", l.discount, l."grossAmount", l."lineDiscount",
              l."billDiscountShare", l."taxableAmount", l."taxRatePercent", l."cessRatePercent",
              l.cgst, l.sgst, l.igst, l.cess, l."lineTotal", l."supplyCategory"
       FROM jsonb_to_recordset($2::jsonb) AS l(${LINE_RECORDSET})`,
      [orderId, JSON.stringify(lines)],
    );
  },

  /** Rewrites lines that already belong to this order; `quantity_fulfilled` is never touched. */
  async updateLines(tx: Tx, orderId: string, lines: readonly SaleOrderLineWrite[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.query(
      `UPDATE sales_order_lines t SET
         line_no = l."lineNo", item_id = l."itemId", item_name = l."itemName", hsn_code = l."hsnCode",
         unit = l.unit, quantity = l.quantity, unit_price = l."unitPrice", discount = l.discount,
         gross_amount = l."grossAmount", line_discount = l."lineDiscount",
         bill_discount_share = l."billDiscountShare", taxable_amount = l."taxableAmount",
         tax_rate_percent = l."taxRatePercent", cess_rate_percent = l."cessRatePercent",
         cgst = l.cgst, sgst = l.sgst, igst = l.igst, cess = l.cess, line_total = l."lineTotal",
         supply_category = l."supplyCategory"
       FROM jsonb_to_recordset($2::jsonb) AS l(${LINE_RECORDSET})
       WHERE t.sales_order_id = $1 AND t.id = l.id`,
      [orderId, JSON.stringify(lines)],
    );
  },

  async deleteLines(tx: Tx, orderId: string, lineIds: readonly string[]): Promise<void> {
    if (lineIds.length === 0) return;
    await tx.query(
      'DELETE FROM sales_order_lines WHERE sales_order_id = $1 AND id = ANY($2::uuid[])',
      [orderId, [...lineIds]],
    );
  },

  /**
   * One row per order line: several invoice lines may claim the same order line, and an
   * UPDATE ... FROM with duplicate matches would apply only one of them.
   */
  async applyFulfilment(
    tx: Tx,
    orderId: string,
    fulfilments: readonly { lineId: string; quantity: number }[],
  ): Promise<void> {
    if (fulfilments.length === 0) return;
    await tx.query(
      `UPDATE sales_order_lines l
       SET quantity_fulfilled = l.quantity_fulfilled + r.quantity
       FROM (SELECT "lineId", SUM(quantity)::bigint AS quantity
             FROM jsonb_to_recordset($2::jsonb) AS x("lineId" uuid, quantity bigint)
             GROUP BY "lineId") r
       WHERE l.sales_order_id = $1 AND l.id = r."lineId"`,
      [orderId, JSON.stringify(fulfilments)],
    );
  },

  /** Undoes a voided invoice's contribution to the order's fulfilled quantities. */
  async reverseFulfilment(tx: Tx, orderId: string, invoiceId: string): Promise<void> {
    await tx.query(
      `UPDATE sales_order_lines l
       SET quantity_fulfilled = GREATEST(0, l.quantity_fulfilled - r.quantity)
       FROM (SELECT il.sales_order_line_id AS line_id, SUM(il.quantity)::bigint AS quantity
             FROM invoice_lines il
             WHERE il.invoice_id = $2 AND il.sales_order_line_id IS NOT NULL
             GROUP BY il.sales_order_line_id) r
       WHERE r.line_id = l.id AND l.sales_order_id = $1`,
      [orderId, invoiceId],
    );
  },

  /** What a credit note hands back: the returned quantity stops counting as delivered. */
  async reverseFulfilmentForCreditNote(
    tx: Tx,
    orderId: string,
    creditNoteId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE sales_order_lines l
       SET quantity_fulfilled = GREATEST(0, l.quantity_fulfilled - r.quantity)
       FROM (SELECT il.sales_order_line_id AS line_id, SUM(cl.quantity)::bigint AS quantity
             FROM credit_note_lines cl
             JOIN invoice_lines il ON il.id = cl.invoice_line_id
             WHERE cl.credit_note_id = $2 AND il.sales_order_line_id IS NOT NULL
             GROUP BY il.sales_order_line_id) r
       WHERE r.line_id = l.id AND l.sales_order_id = $1`,
      [orderId, creditNoteId],
    );
  },

  /** A voided credit note is a return that never happened: the goods count as delivered again. */
  async reapplyFulfilmentForCreditNote(
    tx: Tx,
    orderId: string,
    creditNoteId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE sales_order_lines l
       SET quantity_fulfilled = LEAST(l.quantity, l.quantity_fulfilled + r.quantity)
       FROM (SELECT il.sales_order_line_id AS line_id, SUM(cl.quantity)::bigint AS quantity
             FROM credit_note_lines cl
             JOIN invoice_lines il ON il.id = cl.invoice_line_id
             WHERE cl.credit_note_id = $2 AND il.sales_order_line_id IS NOT NULL
             GROUP BY il.sales_order_line_id) r
       WHERE r.line_id = l.id AND l.sales_order_id = $1`,
      [orderId, creditNoteId],
    );
  },

  /**
   * Recomputes status from the lines, so a void and an invoice cannot leave it
   * saying something its lines contradict. Cancelled stays cancelled; a manual
   * close stays closed until an edit adds something to deliver.
   */
  async refreshStatus(tx: Tx, orderId: string): Promise<void> {
    await tx.query(
      `UPDATE sales_orders so
       SET status = CASE
             WHEN so.status = 'cancelled' THEN 'cancelled'
             WHEN so.closed_manually THEN 'closed'
             WHEN NOT EXISTS (SELECT 1 FROM sales_order_lines l
                              WHERE l.sales_order_id = so.id AND l.quantity_fulfilled > 0)
               THEN 'open'
             WHEN NOT EXISTS (SELECT 1 FROM sales_order_lines l
                              WHERE l.sales_order_id = so.id AND l.quantity_fulfilled < l.quantity)
               THEN 'closed'
             ELSE 'partial'
           END
       WHERE so.id = $1`,
      [orderId],
    );
  },

  async setClosedManually(tx: Tx, orderId: string, value: boolean): Promise<void> {
    await tx.query('UPDATE sales_orders SET closed_manually = $2 WHERE id = $1', [orderId, value]);
  },

  async cancel(tx: Tx, orderId: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE sales_orders SET status = 'cancelled', cancelled_reason = $2, cancelled_at = now()
       WHERE id = $1`,
      [orderId, reason],
    );
  },

  async softDelete(tx: Tx, orderId: string): Promise<void> {
    await tx.query('UPDATE sales_orders SET deleted_at = now() WHERE id = $1', [orderId]);
  },

  /** Advance bookkeeping on the order only; the payment row is written by the service. */
  async setAdvance(
    tx: Tx,
    orderId: string,
    advanceAmount: number,
    paymentId: string | null,
  ): Promise<void> {
    await tx.query(
      'UPDATE sales_orders SET advance_amount = $2, advance_payment_id = $3 WHERE id = $1',
      [orderId, advanceAmount, paymentId],
    );
  },

  async addRefunded(tx: Tx, orderId: string, amount: number): Promise<void> {
    await tx.query(
      'UPDATE sales_orders SET advance_refunded = advance_refunded + $2 WHERE id = $1',
      [orderId, amount],
    );
  },

  /**
   * Where the advance stands. Computed from the payments, never stored, so a voided
   * invoice gives back what it had used without anything having to be un-written
   * (allocations are immutable).
   */
  async advanceState(tx: Tx, orderId: string): Promise<AdvanceState> {
    const row = await tx.one<{ taken: number; refunded: number; applied: number }>(
      `SELECT
         COALESCE((SELECT SUM(p.amount) FROM payments p
                   WHERE p.sales_order_id = $1 AND p.kind = 'order_advance' AND p.status = 'issued'), 0)::bigint AS taken,
         COALESCE((SELECT SUM(p.amount) FROM payments p
                   WHERE p.sales_order_id = $1 AND p.kind = 'refund' AND p.status = 'issued'), 0)::bigint AS refunded,
         COALESCE((SELECT SUM(pa.amount)
                   FROM payment_allocations pa
                   JOIN payments p ON p.id = pa.payment_id
                   JOIN invoices i ON i.id = pa.invoice_id
                   WHERE p.sales_order_id = $1 AND p.kind = 'order_advance'
                     AND p.status = 'issued' AND i.status = 'issued'
                     -- An invoice that has been replaced gave its advance up to the
                     -- replacement: the credit note took the original back.
                     AND NOT EXISTS (SELECT 1 FROM invoices r
                                     WHERE r.amends_invoice_id = i.id AND r.status = 'issued')), 0)::bigint AS applied`,
      [orderId],
    );
    const taken = row?.taken ?? 0;
    const refunded = row?.refunded ?? 0;
    const applied = row?.applied ?? 0;
    return { taken, refunded, applied, remaining: Math.max(0, taken - refunded - applied) };
  },

  /** The invoices raised against the order, oldest first. */
  findInvoices(tx: Tx, orderId: string): Promise<OrderInvoiceRow[]> {
    return tx.many<OrderInvoiceRow>(
      `SELECT id, document_number AS "documentNumber", document_date AS "documentDate",
              grand_total AS "grandTotal", bill_discount_amount AS "billDiscountAmount", status,
              amends_invoice_id AS "amendsInvoiceId"
       FROM invoices WHERE sales_order_id = $1 ORDER BY issued_at, id`,
      [orderId],
    );
  },

  /**
   * What the order's bill-level discount still has to give. Each standing invoice carries
   * its share; the rest is what a new invoice may carry.
   */
  async billDiscountInvoiced(tx: Tx, orderId: string): Promise<number> {
    const row = await tx.one<{ total: number }>(
      `SELECT COALESCE(SUM(bill_discount_amount), 0)::bigint AS total FROM invoices
       WHERE sales_order_id = $1 AND status = 'issued'`,
      [orderId],
    );
    return row?.total ?? 0;
  },

  /**
   * What an order currently reserves, per item, and where. Only open and partial orders
   * reserve, and only items that track stock: a custom line or a service is never on a shelf.
   */
  async reservedFor(
    tx: Tx,
    orderId: string,
  ): Promise<{ outletId: string | null; byItem: Map<string, number> }> {
    const rows = await tx.many<{ outletId: string; itemId: string; reserved: number }>(
      `SELECT so.outlet_id AS "outletId", l.item_id AS "itemId",
              SUM(GREATEST(0, l.quantity - l.quantity_fulfilled))::bigint AS reserved
       FROM sales_orders so
       JOIN sales_order_lines l ON l.sales_order_id = so.id
       JOIN items i ON i.id = l.item_id
       WHERE so.id = $1 AND so.deleted_at IS NULL AND so.status IN ('open', 'partial') AND i.track_stock
       GROUP BY so.outlet_id, l.item_id`,
      [orderId],
    );
    const outlet = await tx.one<{ outletId: string }>(
      'SELECT outlet_id AS "outletId" FROM sales_orders WHERE id = $1',
      [orderId],
    );
    return {
      outletId: outlet?.outletId ?? null,
      byItem: new Map(rows.map((r) => [r.itemId, r.reserved])),
    };
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
  ): Promise<SaleOrderRow[]> {
    return tx.many<SaleOrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM sales_orders so
       WHERE so.deleted_at IS NULL
         AND ($1::text IS NULL OR so.status = $1)
         AND ($2::uuid IS NULL OR so.customer_id = $2)
         AND ($3::uuid IS NULL OR so.outlet_id = $3)
         AND ($4::uuid[] IS NULL OR so.outlet_id = ANY($4::uuid[]))
         AND ($5::date IS NULL OR (so.document_date, so.id) < ($5::date, $6::uuid))
         AND ($8::text IS NULL OR so.document_number ILIKE $8 OR so.customer_name ILIKE $8
              OR so.customer_phone ILIKE $8)
       ORDER BY so.document_date DESC, so.id DESC
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

  /** Counts for the filter chips. Cancelled orders are counted under no chip but All. */
  async summary(
    tx: Tx,
    outletId: string | undefined,
    restrictTo: readonly string[] | null,
  ): Promise<{ all: number; open: number; partial: number; closed: number }> {
    const row = await tx.one<{ all: number; open: number; partial: number; closed: number }>(
      `SELECT count(*)::int AS "all",
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'partial')::int AS partial,
              count(*) FILTER (WHERE status = 'closed')::int AS closed
       FROM sales_orders
       WHERE deleted_at IS NULL
         AND ($1::uuid IS NULL OR outlet_id = $1)
         AND ($2::uuid[] IS NULL OR outlet_id = ANY($2::uuid[]))`,
      [outletId ?? null, restrictTo ? [...restrictTo] : null],
    );
    return row ?? { all: 0, open: 0, partial: 0, closed: 0 };
  },
};
