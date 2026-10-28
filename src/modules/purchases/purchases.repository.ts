import type { Tx } from '../../db/tx.js';
import { jsonParam, likeContains } from '../../db/sql.js';
import type { LandedCostBasis } from '../../domain/costing/landed-cost.js';
import type {
  Discount,
  SupplyCategory,
  TaxInvoiceResult,
} from '../../domain/tax/types.js';
import type { Cursor } from '../../lib/pagination.js';
import type { TermsSnapshot } from '../terms/terms.schemas.js';

export interface PurchaseBillHeaderInsert {
  id: string;
  outletId: string;
  supplierId: string;
  purchaseOrderId: string | null;
  seriesId: string | null;
  sequenceNo: number | null;
  documentNumber: string;
  documentDate: string;
  fyStartYear: number;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  dueDate: string | null;
  supplierGstin: string | null;
  supplierStateCode: string | null;
  placeOfSupplyStateCode: string | null;
  pricesIncludeTax: boolean;
  roundOffEnabled: boolean;
  itcEligible: boolean;
  itcCategory: string | null;
  itcIneligibleReason: string | null;
  totals: TaxInvoiceResult;
  billDiscount: Discount | null;
  freightAmount: number;
  otherChargesAmount: number;
  landedCostBasis: LandedCostBasis;
  notes: string | null;
  termsId: string | null;
  termsSnapshot: TermsSnapshot | null;
  attachments: readonly unknown[];
  receivedAt: string;
  createdBy: string;
}

export interface PurchaseBillLineInsert {
  id: string;
  purchaseOrderLineId: string | null;
  lineNo: number;
  itemId: string;
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
  landedCostShare: number;
  effectiveUnitCost: number;
  supplyCategory: SupplyCategory;
}

export interface PurchaseBillHeaderRow {
  id: string;
  outletId: string;
  supplierId: string;
  purchaseOrderId: string | null;
  documentNumber: string;
  documentDate: string;
  supplierInvoiceNo: string;
  grandTotal: number;
  status: 'issued' | 'void';
  amountPaid: number;
  returnedAmount: number;
  [column: string]: unknown;
}

export interface PurchaseBillSummaryRow {
  id: string;
  outletId: string;
  supplierId: string;
  supplierName: string;
  documentNumber: string;
  supplierInvoiceNo: string;
  documentDate: string;
  dueDate: string | null;
  grandTotal: number;
  amountPaid: number;
  status: 'issued' | 'void';
}

const AMOUNT_PAID = `COALESCE((
  SELECT SUM(a.amount) FROM supplier_payment_allocations a
  JOIN supplier_payments p ON p.id = a.supplier_payment_id
  WHERE a.purchase_bill_id = pb.id AND p.status = 'issued'), 0)`;

const RETURNED = `COALESCE((
  SELECT SUM(d.grand_total) FROM debit_notes d
  WHERE d.purchase_bill_id = pb.id AND d.status = 'issued'), 0)`;

const HEADER_COLUMNS = `
  pb.id, pb.outlet_id AS "outletId", pb.supplier_id AS "supplierId",
  pb.purchase_order_id AS "purchaseOrderId", pb.series_id AS "seriesId",
  pb.sequence_no AS "sequenceNo", pb.document_number AS "documentNumber",
  pb.document_date AS "documentDate", pb.fy_start_year AS "fyStartYear",
  pb.supplier_invoice_no AS "supplierInvoiceNo", pb.supplier_invoice_date AS "supplierInvoiceDate",
  pb.due_date AS "dueDate", pb.supplier_gstin AS "supplierGstin",
  pb.supplier_state_code AS "supplierStateCode",
  pb.place_of_supply_state_code AS "placeOfSupplyStateCode", pb.tax_mode AS "taxMode",
  pb.supply_type AS "supplyType", pb.prices_include_tax AS "pricesIncludeTax",
  pb.round_off_enabled AS "roundOffEnabled", pb.itc_eligible AS "itcEligible",
  pb.is_reverse_charge AS "isReverseCharge", pb.itc_category AS "itcCategory",
  pb.itc_ineligible_reason AS "itcIneligibleReason",
  pb.gross_amount AS "grossAmount", pb.line_discount_total AS "lineDiscountTotal",
  pb.bill_discount AS "billDiscount", pb.bill_discount_amount AS "billDiscountAmount",
  pb.taxable_amount AS "taxableAmount", pb.total_cgst AS "totalCgst", pb.total_sgst AS "totalSgst",
  pb.total_igst AS "totalIgst", pb.total_cess AS "totalCess", pb.total_tax AS "totalTax",
  pb.sub_total AS "subTotal", pb.round_off AS "roundOff", pb.grand_total AS "grandTotal",
  pb.tax_summary AS "taxSummary", pb.hsn_summary AS "hsnSummary",
  pb.freight_amount AS "freightAmount", pb.other_charges_amount AS "otherChargesAmount",
  pb.landed_cost_basis AS "landedCostBasis", pb.notes, pb.status,
  pb.terms_id AS "termsId", pb.terms_snapshot AS "termsSnapshot", pb.attachments,
  pb.received_at AS "receivedAt", pb.created_by AS "createdBy", pb.void_reason AS "voidReason",
  pb.voided_at AS "voidedAt", pb.created_at AS "createdAt",
  ${AMOUNT_PAID} AS "amountPaid", ${RETURNED} AS "returnedAmount"`;

const LINE_COLUMNS = `
  id, purchase_order_line_id AS "purchaseOrderLineId", line_no AS "lineNo", item_id AS "itemId",
  item_name AS "itemName", hsn_code AS "hsnCode", unit, quantity, unit_price AS "unitPrice",
  discount, gross_amount AS "grossAmount", line_discount AS "lineDiscount",
  bill_discount_share AS "billDiscountShare", taxable_amount AS "taxableAmount",
  tax_rate_percent AS "taxRatePercent", cess_rate_percent AS "cessRatePercent",
  cgst, sgst, igst, cess, line_total AS "lineTotal", landed_cost_share AS "landedCostShare",
  effective_unit_cost AS "effectiveUnitCost"`;

export interface SupplierPaymentRow {
  id: string;
  outletId: string;
  supplierId: string;
  mode: string;
  amount: number;
  reference: string | null;
  paidAt: Date;
  paidBy: string;
  status: 'issued' | 'void';
  notes: string | null;
  voidReason: string | null;
  voidedAt: Date | null;
  allocatedAmount: number;
  createdAt: Date;
}

export interface NewSupplierPayment {
  id: string;
  outletId: string;
  supplierId: string;
  mode: string;
  amount: number;
  reference: string | null;
  paidAt: string;
  paidBy: string;
  notes: string | null;
}

const PAYMENT_COLUMNS = `
  sp.id, sp.outlet_id AS "outletId", sp.supplier_id AS "supplierId", sp.mode, sp.amount,
  sp.reference, sp.paid_at AS "paidAt", sp.paid_by AS "paidBy", sp.status, sp.notes,
  sp.void_reason AS "voidReason", sp.voided_at AS "voidedAt", sp.created_at AS "createdAt",
  COALESCE((SELECT SUM(a.amount) FROM supplier_payment_allocations a
            WHERE a.supplier_payment_id = sp.id), 0) AS "allocatedAmount"`;

export interface PurchaseBillFilter {
  from: string | undefined;
  to: string | undefined;
  status: string | undefined;
  supplierId: string | undefined;
  outletId: string | undefined;
  unpaidOnly: boolean;
  q: string | undefined;
}

export const purchasesRepository = {
  async billExists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM purchase_bills WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  /**
   * Catches re-entry of the same supplier bill before the unique index does,
   * so the user sees a message naming the existing document rather than a
   * generic duplicate-key conflict.
   */
  findBySupplierInvoice(tx: Tx, supplierId: string, invoiceNo: string, fyStartYear: number) {
    return tx.one<{ id: string; documentNumber: string }>(
      `SELECT id, document_number AS "documentNumber" FROM purchase_bills
       WHERE supplier_id = $1 AND upper(trim(supplier_invoice_no)) = upper(trim($2))
         AND fy_start_year = $3 AND status <> 'void'`,
      [supplierId, invoiceNo, fyStartYear],
    );
  },

  async insertBill(tx: Tx, h: PurchaseBillHeaderInsert): Promise<void> {
    const t = h.totals;
    await tx.query(
      `INSERT INTO purchase_bills (
         id, tenant_id, outlet_id, supplier_id, purchase_order_id, series_id, sequence_no,
         document_number, document_date, fy_start_year, supplier_invoice_no, supplier_invoice_date,
         due_date, supplier_gstin, supplier_state_code, place_of_supply_state_code,
         tax_mode, supply_type, prices_include_tax, round_off_enabled, itc_eligible,
         gross_amount, line_discount_total, bill_discount, bill_discount_amount, taxable_amount,
         total_cgst, total_sgst, total_igst, total_cess, total_tax, sub_total, round_off,
         grand_total, tax_summary, hsn_summary, freight_amount, other_charges_amount,
         landed_cost_basis, notes, status, received_at, created_by, is_reverse_charge,
         itc_category, itc_ineligible_reason, terms_id, terms_snapshot, attachments)
       VALUES (
         $1, app.current_tenant_id(), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16, $17, $18, $19, $20,
         $21, $22, $23, $24, $25,
         $26, $27, $28, $29, $30, $31, $32,
         $33, $34, $35, $36, $37,
         $38, $39, 'issued', $40, $41, $42, $43, $44, $45, $46, $47::jsonb)`,
      [
        h.id,
        h.outletId,
        h.supplierId,
        h.purchaseOrderId,
        h.seriesId,
        h.sequenceNo,
        h.documentNumber,
        h.documentDate,
        h.fyStartYear,
        h.supplierInvoiceNo,
        h.supplierInvoiceDate,
        h.dueDate,
        h.supplierGstin,
        h.supplierStateCode,
        h.placeOfSupplyStateCode,
        t.mode,
        t.supplyType,
        h.pricesIncludeTax,
        h.roundOffEnabled,
        h.itcEligible,
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
        h.freightAmount,
        h.otherChargesAmount,
        h.landedCostBasis,
        h.notes,
        h.receivedAt,
        h.createdBy,
        t.isReverseCharge,
        h.itcCategory,
        h.itcIneligibleReason,
        h.termsId,
        jsonParam(h.termsSnapshot),
        JSON.stringify(h.attachments),
      ],
    );
  },

  async insertBillLines(
    tx: Tx,
    billId: string,
    outletId: string,
    documentDate: string,
    lines: readonly PurchaseBillLineInsert[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO purchase_bill_lines (id, tenant_id, purchase_bill_id, purchase_order_line_id,
         outlet_id, document_date, line_no, item_id, item_name, hsn_code, unit, quantity, unit_price,
         discount, gross_amount, line_discount, bill_discount_share, taxable_amount,
         tax_rate_percent, cess_rate_percent, cgst, sgst, igst, cess, line_total,
         landed_cost_share, effective_unit_cost, supply_category)
       SELECT l.id, app.current_tenant_id(), $1, l."purchaseOrderLineId", $2, $3, l."lineNo",
              l."itemId", l."itemName", l."hsnCode", l.unit, l.quantity, l."unitPrice",
              l.discount, l."grossAmount", l."lineDiscount", l."billDiscountShare", l."taxableAmount",
              l."taxRatePercent", l."cessRatePercent", l.cgst, l.sgst, l.igst, l.cess, l."lineTotal",
              l."landedCostShare", l."effectiveUnitCost", l."supplyCategory"
       FROM jsonb_to_recordset($4::jsonb) AS l(
         id uuid, "purchaseOrderLineId" uuid, "lineNo" int, "itemId" uuid, "itemName" text,
         "hsnCode" text, unit text, quantity bigint, "unitPrice" bigint, discount jsonb,
         "grossAmount" bigint, "lineDiscount" bigint, "billDiscountShare" bigint,
         "taxableAmount" bigint, "taxRatePercent" numeric, "cessRatePercent" numeric,
         cgst bigint, sgst bigint, igst bigint, cess bigint, "lineTotal" bigint,
         "landedCostShare" bigint, "effectiveUnitCost" bigint, "supplyCategory" text)`,
      [billId, outletId, documentDate, JSON.stringify(lines)],
    );
  },

  findBill(tx: Tx, id: string, forUpdate = false): Promise<PurchaseBillHeaderRow | undefined> {
    return tx.one<PurchaseBillHeaderRow>(
      `SELECT ${HEADER_COLUMNS} FROM purchase_bills pb WHERE pb.id = $1 ${
        forUpdate ? 'FOR UPDATE OF pb' : ''
      }`,
      [id],
    );
  },

  findBillLines(tx: Tx, billId: string) {
    return tx.many(
      `SELECT ${LINE_COLUMNS} FROM purchase_bill_lines WHERE purchase_bill_id = $1 ORDER BY line_no`,
      [billId],
    );
  },

  listBills(
    tx: Tx,
    filter: PurchaseBillFilter,
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<PurchaseBillSummaryRow[]> {
    return tx.many<PurchaseBillSummaryRow>(
      `SELECT pb.id, pb.outlet_id AS "outletId", pb.supplier_id AS "supplierId", s.name AS "supplierName",
              pb.document_number AS "documentNumber", pb.supplier_invoice_no AS "supplierInvoiceNo",
              pb.document_date AS "documentDate", pb.due_date AS "dueDate",
              pb.grand_total AS "grandTotal", ${AMOUNT_PAID} AS "amountPaid", pb.status
       FROM purchase_bills pb
       JOIN suppliers s ON s.id = pb.supplier_id
       WHERE ($1::date IS NULL OR pb.document_date >= $1)
         AND ($2::date IS NULL OR pb.document_date <= $2)
         AND ($3::text IS NULL OR pb.status = $3)
         AND ($4::uuid IS NULL OR pb.supplier_id = $4)
         AND ($5::uuid IS NULL OR pb.outlet_id = $5)
         AND ($6::uuid[] IS NULL OR pb.outlet_id = ANY($6::uuid[]))
         AND (NOT $7::boolean OR (pb.status = 'issued' AND pb.grand_total > ${AMOUNT_PAID} + ${RETURNED}))
         AND ($8::date IS NULL OR (pb.document_date, pb.id) < ($8::date, $9::uuid))
         AND ($11::text IS NULL OR pb.document_number ILIKE $11 OR pb.supplier_invoice_no ILIKE $11
              OR s.name ILIKE $11)
       ORDER BY pb.document_date DESC, pb.id DESC
       LIMIT $10`,
      [
        filter.from ?? null,
        filter.to ?? null,
        filter.status ?? null,
        filter.supplierId ?? null,
        filter.outletId ?? null,
        restrictTo ? [...restrictTo] : null,
        filter.unpaidOnly,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
        filter.q ? likeContains(filter.q) : null,
      ],
    );
  },

  async markBillVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      `UPDATE purchase_bills SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3
       WHERE id = $1`,
      [id, reason, userId],
    );
  },

  // --- Supplier payments ----------------------------------------------------

  findPayment(tx: Tx, id: string, forUpdate = false): Promise<SupplierPaymentRow | undefined> {
    return tx.one<SupplierPaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM supplier_payments sp WHERE sp.id = $1 ${
        forUpdate ? 'FOR UPDATE OF sp' : ''
      }`,
      [id],
    );
  },

  async insertPayment(tx: Tx, p: NewSupplierPayment): Promise<void> {
    await tx.query(
      `INSERT INTO supplier_payments (id, tenant_id, outlet_id, supplier_id, mode, amount,
         reference, paid_at, paid_by, status, notes)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, 'issued', $9)`,
      [p.id, p.outletId, p.supplierId, p.mode, p.amount, p.reference, p.paidAt, p.paidBy, p.notes],
    );
  },

  async insertAllocations(
    tx: Tx,
    allocations: readonly { supplierPaymentId: string; purchaseBillId: string; amount: number }[],
  ): Promise<void> {
    if (allocations.length === 0) return;
    await tx.query(
      `INSERT INTO supplier_payment_allocations (id, tenant_id, supplier_payment_id,
         purchase_bill_id, amount)
       SELECT gen_random_uuid(), app.current_tenant_id(), a."supplierPaymentId",
              a."purchaseBillId", a.amount
       FROM jsonb_to_recordset($1::jsonb) AS a(
         "supplierPaymentId" uuid, "purchaseBillId" uuid, amount bigint)`,
      [JSON.stringify(allocations)],
    );
  },

  listPayments(
    tx: Tx,
    filter: { supplierId: string | undefined; from: string | undefined; to: string | undefined },
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<SupplierPaymentRow[]> {
    return tx.many<SupplierPaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM supplier_payments sp
       WHERE ($1::uuid IS NULL OR sp.supplier_id = $1)
         AND ($2::date IS NULL OR sp.paid_at >= $2::date)
         AND ($3::date IS NULL OR sp.paid_at < ($3::date + 1))
         AND ($4::uuid[] IS NULL OR sp.outlet_id = ANY($4::uuid[]))
         AND ($5::timestamptz IS NULL OR (sp.paid_at, sp.id) < ($5::timestamptz, $6::uuid))
       ORDER BY sp.paid_at DESC, sp.id DESC
       LIMIT $7`,
      [
        filter.supplierId ?? null,
        filter.from ?? null,
        filter.to ?? null,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async markPaymentVoid(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
    await tx.query(
      `UPDATE supplier_payments SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3
       WHERE id = $1`,
      [id, reason, userId],
    );
  },

  // --- Item cost ------------------------------------------------------------

  /**
   * The cost row, locked.
   *
   * `FOR UPDATE` and the insert-if-absent together serialise two bills for
   * the same item: without the lock, both would read the same average and
   * the second write would discard the first.
   */
  async lockCost(tx: Tx, outletId: string, itemId: string) {
    const existing = await tx.one<{ avgCost: number; quantityOnHand: number }>(
      `SELECT avg_cost AS "avgCost", quantity_on_hand AS "quantityOnHand" FROM item_costs
       WHERE outlet_id = $1 AND item_id = $2 FOR UPDATE`,
      [outletId, itemId],
    );
    if (existing) return existing;

    // Seeded from whatever stock is already on hand, so the first purchase
    // after go-live blends against the real quantity rather than zero.
    await tx.query(
      `INSERT INTO item_costs (tenant_id, outlet_id, item_id, avg_cost, quantity_on_hand)
       VALUES (app.current_tenant_id(), $1, $2, 0,
               COALESCE((SELECT quantity FROM stock_balances
                         WHERE outlet_id = $1 AND item_id = $2), 0))
       ON CONFLICT (tenant_id, outlet_id, item_id) DO NOTHING`,
      [outletId, itemId],
    );
    const seeded = await tx.one<{ avgCost: number; quantityOnHand: number }>(
      `SELECT avg_cost AS "avgCost", quantity_on_hand AS "quantityOnHand" FROM item_costs
       WHERE outlet_id = $1 AND item_id = $2 FOR UPDATE`,
      [outletId, itemId],
    );
    return seeded ?? { avgCost: 0, quantityOnHand: 0 };
  },

  async writeCost(
    tx: Tx,
    outletId: string,
    itemId: string,
    cost: { avgCost: number; quantityOnHand: number },
    lastPurchase: { unitCost: number; at: string } | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE item_costs
       SET avg_cost = $3, quantity_on_hand = $4,
           last_purchase_cost = COALESCE($5, last_purchase_cost),
           last_purchase_at   = COALESCE($6, last_purchase_at)
       WHERE outlet_id = $1 AND item_id = $2`,
      [
        outletId,
        itemId,
        cost.avgCost,
        cost.quantityOnHand,
        lastPurchase?.unitCost ?? null,
        lastPurchase?.at ?? null,
      ],
    );
  },

  /** Average costs for a set of items, for costing a sale. */
  async costsFor(tx: Tx, outletId: string, itemIds: readonly string[]) {
    const rows = await tx.many<{ itemId: string; avgCost: number }>(
      `SELECT item_id AS "itemId", avg_cost AS "avgCost" FROM item_costs
       WHERE outlet_id = $1 AND item_id = ANY($2::uuid[])`,
      [outletId, [...new Set(itemIds)]],
    );
    return new Map(rows.map((r) => [r.itemId, r.avgCost]));
  },

  /** Applies a sale's quantity change without touching the average. */
  async adjustCostQuantity(
    tx: Tx,
    outletId: string,
    deltas: readonly { itemId: string; quantityDelta: number }[],
  ): Promise<void> {
    if (deltas.length === 0) return;
    await tx.query(
      `UPDATE item_costs c
       SET quantity_on_hand = c.quantity_on_hand + d."quantityDelta"
       FROM jsonb_to_recordset($2::jsonb) AS d("itemId" uuid, "quantityDelta" bigint)
       WHERE c.outlet_id = $1 AND c.item_id = d."itemId"`,
      [outletId, JSON.stringify(deltas)],
    );
  },
};
