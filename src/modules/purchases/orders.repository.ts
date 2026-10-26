import type { Tx } from '../../db/tx.js';
import { jsonParam, likeContains } from '../../db/sql.js';
import type { Cursor } from '../../lib/pagination.js';
import type { TermsSnapshot } from '../terms/terms.schemas.js';

export interface PurchaseOrderRow {
  id: string;
  outletId: string;
  supplierId: string;
  supplierName: string;
  documentNumber: string;
  documentDate: string;
  expectedDate: string | null;
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
  estimatedTotal: number;
  notes: string | null;
  termsId: string | null;
  termsSnapshot: TermsSnapshot | null;
  createdAt: Date;
}

export interface PurchaseOrderLineRow {
  id: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  unit: string | null;
  quantityOrdered: number;
  quantityReceived: number;
  expectedUnitCost: number;
}

export interface NewPurchaseOrder {
  id: string;
  outletId: string;
  supplierId: string;
  seriesId: string | null;
  sequenceNo: number | null;
  documentNumber: string;
  documentDate: string;
  fyStartYear: number;
  expectedDate: string | null;
  estimatedTotal: number;
  notes: string | null;
  termsId: string | null;
  termsSnapshot: TermsSnapshot | null;
  createdBy: string;
}

export interface NewPurchaseOrderLine {
  id: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  unit: string | null;
  quantityOrdered: number;
  expectedUnitCost: number;
}

const ORDER_COLUMNS = `
  po.id, po.outlet_id AS "outletId", po.supplier_id AS "supplierId", s.name AS "supplierName",
  po.document_number AS "documentNumber", po.document_date AS "documentDate",
  po.expected_date AS "expectedDate", po.status, po.estimated_total AS "estimatedTotal",
  po.notes, po.terms_id AS "termsId", po.terms_snapshot AS "termsSnapshot",
  po.created_at AS "createdAt"`;

const LINE_COLUMNS = `
  id, line_no AS "lineNo", item_id AS "itemId", item_name AS "itemName", unit,
  quantity_ordered AS "quantityOrdered", quantity_received AS "quantityReceived",
  expected_unit_cost AS "expectedUnitCost"`;

export const ordersRepository = {
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM purchase_orders WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  find(tx: Tx, id: string, forUpdate = false): Promise<PurchaseOrderRow | undefined> {
    return tx.one<PurchaseOrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = $1 AND po.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF po' : ''}`,
      [id],
    );
  },

  findLines(tx: Tx, orderId: string): Promise<PurchaseOrderLineRow[]> {
    return tx.many<PurchaseOrderLineRow>(
      `SELECT ${LINE_COLUMNS} FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no`,
      [orderId],
    );
  },

  async insert(tx: Tx, o: NewPurchaseOrder): Promise<void> {
    await tx.query(
      `INSERT INTO purchase_orders (id, tenant_id, outlet_id, supplier_id, series_id, sequence_no,
         document_number, document_date, fy_start_year, expected_date, status, estimated_total,
         notes, created_by, terms_id, terms_snapshot)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, 'sent', $10, $11, $12, $13, $14)`,
      [
        o.id,
        o.outletId,
        o.supplierId,
        o.seriesId,
        o.sequenceNo,
        o.documentNumber,
        o.documentDate,
        o.fyStartYear,
        o.expectedDate,
        o.estimatedTotal,
        o.notes,
        o.createdBy,
        o.termsId,
        jsonParam(o.termsSnapshot),
      ],
    );
  },

  async insertLines(
    tx: Tx,
    orderId: string,
    lines: readonly NewPurchaseOrderLine[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO purchase_order_lines (id, tenant_id, purchase_order_id, line_no, item_id,
         item_name, unit, quantity_ordered, expected_unit_cost)
       SELECT l.id, app.current_tenant_id(), $1, l."lineNo", l."itemId", l."itemName", l.unit,
              l."quantityOrdered", l."expectedUnitCost"
       FROM jsonb_to_recordset($2::jsonb) AS l(
         id uuid, "lineNo" int, "itemId" uuid, "itemName" text, unit text,
         "quantityOrdered" bigint, "expectedUnitCost" bigint)`,
      [orderId, JSON.stringify(lines)],
    );
  },

  list(
    tx: Tx,
    filter: {
      supplierId: string | undefined;
      outletId: string | undefined;
      status: string | undefined;
      openOnly: boolean;
      q: string | undefined;
    },
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<PurchaseOrderRow[]> {
    return tx.many<PurchaseOrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.deleted_at IS NULL
         AND ($1::uuid IS NULL OR po.supplier_id = $1)
         AND ($2::uuid IS NULL OR po.outlet_id = $2)
         AND ($3::text IS NULL OR po.status = $3)
         AND (NOT $4::boolean OR po.status IN ('draft', 'sent', 'partial'))
         AND ($5::uuid[] IS NULL OR po.outlet_id = ANY($5::uuid[]))
         AND ($6::date IS NULL OR (po.document_date, po.id) < ($6::date, $7::uuid))
         AND ($9::text IS NULL OR po.document_number ILIKE $9 OR s.name ILIKE $9)
       ORDER BY po.document_date DESC, po.id DESC
       LIMIT $8`,
      [
        filter.supplierId ?? null,
        filter.outletId ?? null,
        filter.status ?? null,
        filter.openOnly,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
        filter.q ? likeContains(filter.q) : null,
      ],
    );
  },

  /**
   * Lines of an order, locked, with what remains to receive.
   *
   * Locked because two bills entered against one order at the same time
   * would otherwise both see the same `quantity_received` and together
   * over-receive the order.
   */
  lockLinesForReceipt(tx: Tx, orderId: string) {
    return tx.many<{ id: string; quantityOrdered: number; quantityReceived: number }>(
      `SELECT id, quantity_ordered AS "quantityOrdered", quantity_received AS "quantityReceived"
       FROM purchase_order_lines WHERE purchase_order_id = $1 FOR UPDATE`,
      [orderId],
    );
  },

  async applyReceipt(
    tx: Tx,
    orderId: string,
    receipts: readonly { lineId: string; quantity: number }[],
  ): Promise<void> {
    if (receipts.length === 0) return;
    await tx.query(
      `UPDATE purchase_order_lines l
       SET quantity_received = l.quantity_received + r.quantity
       FROM jsonb_to_recordset($2::jsonb) AS r("lineId" uuid, quantity bigint)
       WHERE l.purchase_order_id = $1 AND l.id = r."lineId"`,
      [orderId, JSON.stringify(receipts)],
    );
  },

  /** Undoes a voided bill's contribution to the order's received quantities. */
  async reverseReceipt(tx: Tx, orderId: string, billId: string): Promise<void> {
    await tx.query(
      `UPDATE purchase_order_lines l
       SET quantity_received = GREATEST(0, l.quantity_received - b.quantity)
       FROM purchase_bill_lines b
       WHERE b.purchase_bill_id = $2 AND b.purchase_order_line_id = l.id
         AND l.purchase_order_id = $1`,
      [orderId, billId],
    );
  },

  /**
   * Recomputes the order's status from its lines.
   *
   * Derived rather than set by the caller, so a void and a receipt cannot
   * leave it saying something its lines contradict. A cancelled order stays
   * cancelled.
   */
  async refreshStatus(tx: Tx, orderId: string): Promise<void> {
    await tx.query(
      `UPDATE purchase_orders po
       SET status = CASE
             WHEN po.status = 'cancelled' THEN 'cancelled'
             WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines l
                              WHERE l.purchase_order_id = po.id AND l.quantity_received > 0)
               THEN 'sent'
             WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines l
                              WHERE l.purchase_order_id = po.id
                                AND l.quantity_received < l.quantity_ordered)
               THEN 'received'
             ELSE 'partial'
           END
       WHERE po.id = $1`,
      [orderId],
    );
  },

  async updateHeader(
    tx: Tx,
    orderId: string,
    o: {
      supplierId: string;
      documentDate: string;
      expectedDate: string | null;
      estimatedTotal: number;
      notes: string | null;
      termsId: string | null;
      termsSnapshot: TermsSnapshot | null;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE purchase_orders
       SET supplier_id = $2, document_date = $3, expected_date = $4, estimated_total = $5,
           notes = $6, terms_id = $7, terms_snapshot = $8
       WHERE id = $1`,
      [
        orderId,
        o.supplierId,
        o.documentDate,
        o.expectedDate,
        o.estimatedTotal,
        o.notes,
        o.termsId,
        jsonParam(o.termsSnapshot),
      ],
    );
  },

  /** Rewrites lines already on the order; `quantity_received` is never touched. */
  async updateLines(
    tx: Tx,
    orderId: string,
    lines: readonly NewPurchaseOrderLine[],
  ): Promise<void> {
    if (lines.length === 0) return;
    await tx.query(
      `UPDATE purchase_order_lines t
       SET line_no = l."lineNo", item_id = l."itemId", item_name = l."itemName", unit = l.unit,
           quantity_ordered = l."quantityOrdered", expected_unit_cost = l."expectedUnitCost"
       FROM jsonb_to_recordset($2::jsonb) AS l(
         id uuid, "lineNo" int, "itemId" uuid, "itemName" text, unit text,
         "quantityOrdered" bigint, "expectedUnitCost" bigint)
       WHERE t.purchase_order_id = $1 AND t.id = l.id`,
      [orderId, JSON.stringify(lines)],
    );
  },

  async deleteLines(tx: Tx, orderId: string, lineIds: readonly string[]): Promise<void> {
    if (lineIds.length === 0) return;
    await tx.query(
      'DELETE FROM purchase_order_lines WHERE purchase_order_id = $1 AND id = ANY($2::uuid[])',
      [orderId, [...lineIds]],
    );
  },

  async softDelete(tx: Tx, orderId: string): Promise<void> {
    await tx.query('UPDATE purchase_orders SET deleted_at = now() WHERE id = $1', [orderId]);
  },

  async cancel(tx: Tx, orderId: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE purchase_orders SET status = 'cancelled', cancelled_reason = $2, cancelled_at = now()
       WHERE id = $1`,
      [orderId, reason],
    );
  },
};
