import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';

export interface DeliveryChallanRow {
  id: string;
  outletId: string;
  customerId: string | null;
  customerName: string | null;
  documentNumber: string;
  documentDate: string;
  status: 'open' | 'partial' | 'converted' | 'cancelled';
  notes: string | null;
  /** Pictures and files attached to the challan; see `lib/attachments.ts`. */
  attachments: unknown;
  createdAt: Date;
}

export interface DeliveryChallanLineRow {
  id: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  unit: string | null;
  quantity: number;
  quantityInvoiced: number;
}

export interface NewDeliveryChallan {
  id: string;
  outletId: string;
  customerId: string | null;
  seriesId: string | null;
  sequenceNo: number | null;
  documentNumber: string;
  documentDate: string;
  fyStartYear: number;
  notes: string | null;
  attachments: readonly unknown[];
  createdBy: string;
}

export interface NewDeliveryChallanLine {
  id: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  unit: string | null;
  quantity: number;
}

const CHALLAN_COLUMNS = `
  dc.id, dc.outlet_id AS "outletId", dc.customer_id AS "customerId", c.name AS "customerName",
  dc.document_number AS "documentNumber", dc.document_date AS "documentDate",
  dc.status, dc.notes, dc.attachments, dc.created_at AS "createdAt"`;

const LINE_COLUMNS = `
  id, line_no AS "lineNo", item_id AS "itemId", item_name AS "itemName", unit,
  quantity, quantity_invoiced AS "quantityInvoiced"`;

export const deliveryChallansRepository = {
  async exists(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.one<{ found: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM delivery_challans WHERE id = $1) AS found',
      [id],
    );
    return row?.found ?? false;
  },

  find(tx: Tx, id: string, forUpdate = false): Promise<DeliveryChallanRow | undefined> {
    return tx.one<DeliveryChallanRow>(
      `SELECT ${CHALLAN_COLUMNS} FROM delivery_challans dc
       LEFT JOIN customers c ON c.id = dc.customer_id
       WHERE dc.id = $1 ${forUpdate ? 'FOR UPDATE OF dc' : ''}`,
      [id],
    );
  },

  findLines(tx: Tx, challanId: string): Promise<DeliveryChallanLineRow[]> {
    return tx.many<DeliveryChallanLineRow>(
      `SELECT ${LINE_COLUMNS} FROM delivery_challan_lines WHERE delivery_challan_id = $1 ORDER BY line_no`,
      [challanId],
    );
  },

  async insert(tx: Tx, c: NewDeliveryChallan): Promise<void> {
    await tx.query(
      `INSERT INTO delivery_challans (id, tenant_id, outlet_id, customer_id, series_id, sequence_no,
         document_number, document_date, fy_start_year, notes, created_by, attachments)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        c.id,
        c.outletId,
        c.customerId,
        c.seriesId,
        c.sequenceNo,
        c.documentNumber,
        c.documentDate,
        c.fyStartYear,
        c.notes,
        c.createdBy,
        JSON.stringify(c.attachments),
      ],
    );
  },

  async insertLines(
    tx: Tx,
    challanId: string,
    lines: readonly NewDeliveryChallanLine[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO delivery_challan_lines (id, tenant_id, delivery_challan_id, line_no, item_id,
         item_name, unit, quantity)
       SELECT l.id, app.current_tenant_id(), $1, l."lineNo", l."itemId", l."itemName", l.unit, l.quantity
       FROM jsonb_to_recordset($2::jsonb) AS l(
         id uuid, "lineNo" int, "itemId" uuid, "itemName" text, unit text, quantity bigint)`,
      [challanId, JSON.stringify(lines)],
    );
  },

  list(
    tx: Tx,
    filter: {
      customerId: string | undefined;
      outletId: string | undefined;
      status: string | undefined;
      openOnly: boolean;
      closedOnly: boolean;
    },
    restrictTo: readonly string[] | null,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<DeliveryChallanRow[]> {
    return tx.many<DeliveryChallanRow>(
      `SELECT ${CHALLAN_COLUMNS} FROM delivery_challans dc
       LEFT JOIN customers c ON c.id = dc.customer_id
       WHERE ($1::uuid IS NULL OR dc.customer_id = $1)
         AND ($2::uuid IS NULL OR dc.outlet_id = $2)
         AND ($3::text IS NULL OR dc.status = $3)
         AND (NOT $4::boolean OR dc.status IN ('open', 'partial'))
         AND (NOT $5::boolean OR dc.status IN ('converted', 'cancelled'))
         AND ($6::uuid[] IS NULL OR dc.outlet_id = ANY($6::uuid[]))
         AND ($7::date IS NULL OR (dc.document_date, dc.id) < ($7::date, $8::uuid))
       ORDER BY dc.document_date DESC, dc.id DESC
       LIMIT $9`,
      [
        filter.customerId ?? null,
        filter.outletId ?? null,
        filter.status ?? null,
        filter.openOnly,
        filter.closedOnly,
        restrictTo ? [...restrictTo] : null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },

  async updateHeader(
    tx: Tx,
    challanId: string,
    header: {
      customerId: string | null;
      notes: string | null;
      /** Undefined leaves the files alone; a list (even empty) replaces them. */
      attachments?: readonly unknown[];
    },
  ): Promise<void> {
    if (header.attachments === undefined) {
      await tx.query('UPDATE delivery_challans SET customer_id = $2, notes = $3 WHERE id = $1', [
        challanId,
        header.customerId,
        header.notes,
      ]);
      return;
    }
    await tx.query(
      'UPDATE delivery_challans SET customer_id = $2, notes = $3, attachments = $4::jsonb WHERE id = $1',
      [challanId, header.customerId, header.notes, JSON.stringify(header.attachments)],
    );
  },

  /** Full replace: the edit screen always resends every line it wants kept. */
  async replaceLines(
    tx: Tx,
    challanId: string,
    lines: readonly NewDeliveryChallanLine[],
  ): Promise<void> {
    await tx.query('DELETE FROM delivery_challan_lines WHERE delivery_challan_id = $1', [
      challanId,
    ]);
    await this.insertLines(tx, challanId, lines);
  },

  /**
   * Locks specific lines by id, across however many challans they belong
   * to, for "Convert to Invoice" to check against. Locked so two invoices
   * converting the same challan at once cannot both pass and together
   * over-bill it.
   */
  lockLinesByIds(tx: Tx, lineIds: readonly string[]) {
    if (lineIds.length === 0) return Promise.resolve([]);
    return tx.many<{
      id: string;
      deliveryChallanId: string;
      itemId: string;
      quantity: number;
      quantityInvoiced: number;
    }>(
      `SELECT id, delivery_challan_id AS "deliveryChallanId", item_id AS "itemId",
              quantity, quantity_invoiced AS "quantityInvoiced"
       FROM delivery_challan_lines WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [[...lineIds]],
    );
  },

  async applyInvoiced(
    tx: Tx,
    invoiced: readonly { lineId: string; quantity: number }[],
  ): Promise<void> {
    if (invoiced.length === 0) return;
    await tx.query(
      `UPDATE delivery_challan_lines l
       SET quantity_invoiced = l.quantity_invoiced + i.quantity
       FROM jsonb_to_recordset($1::jsonb) AS i("lineId" uuid, quantity bigint)
       WHERE l.id = i."lineId"`,
      [JSON.stringify(invoiced)],
    );
  },

  /**
   * Recomputes a challan's status from its lines, the same way
   * ordersRepository.refreshStatus does for a purchase order — derived
   * rather than set by the caller, so an edit and an invoice cannot leave
   * it saying something its lines contradict. A cancelled challan stays
   * cancelled.
   */
  async refreshStatus(tx: Tx, challanId: string): Promise<void> {
    await tx.query(
      `UPDATE delivery_challans dc
       SET status = CASE
             WHEN dc.status = 'cancelled' THEN 'cancelled'
             WHEN NOT EXISTS (SELECT 1 FROM delivery_challan_lines l
                              WHERE l.delivery_challan_id = dc.id AND l.quantity_invoiced > 0)
               THEN 'open'
             WHEN NOT EXISTS (SELECT 1 FROM delivery_challan_lines l
                              WHERE l.delivery_challan_id = dc.id
                                AND l.quantity_invoiced < l.quantity)
               THEN 'converted'
             ELSE 'partial'
           END
       WHERE dc.id = $1`,
      [challanId],
    );
  },

  async cancel(tx: Tx, challanId: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE delivery_challans SET status = 'cancelled', cancelled_reason = $2, cancelled_at = now()
       WHERE id = $1`,
      [challanId, reason],
    );
  },
};
