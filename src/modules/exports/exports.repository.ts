import type { Tx } from '../../db/tx.js';

/**
 * Export queries.
 *
 * Separate from the list repositories because an export is not a page: it is
 * one bounded sweep, ordered for a human reading a spreadsheet rather than
 * for a cursor. Reusing the paginated queries would mean looping a cursor
 * and paying the keyset predicate on every chunk for no benefit.
 */

export interface ExportItemRow {
  name: string;
  code: string | null;
  barcode: string | null;
  category: string | null;
  hsnCode: string | null;
  unit: string;
  taxRatePercent: string;
  cessRatePercent: string;
  mrp: number | null;
  salePrice: number;
  purchasePrice: number | null;
  reorderLevel: number | null;
  itemType: 'goods' | 'service';
  trackStock: boolean;
}

export interface ExportCustomerRow {
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  addressLine1: string | null;
  city: string | null;
  pincode: string | null;
  creditLimit: number | null;
  balance: number;
}

export interface ExportStockRow {
  name: string;
  code: string | null;
  unit: string;
  quantity: number;
  reorderLevel: number | null;
  purchasePrice: number | null;
}

export interface ExportInvoiceRow {
  documentNumber: string;
  documentDate: string;
  customerName: string | null;
  customerGstin: string | null;
  taxableAmount: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
  grandTotal: number;
  amountPaid: number;
  status: string;
}

export const exportsRepository = {
  /**
   * The first barcode only.
   *
   * The import side writes one barcode per row, so exporting several into
   * one cell would produce a file that cannot be imported back — and
   * silently losing the others on re-import is worse than not offering them.
   */
  items(tx: Tx, includeInactive: boolean, limit: number): Promise<ExportItemRow[]> {
    return tx.many<ExportItemRow>(
      `SELECT i.name, i.code,
              (SELECT b.barcode FROM item_barcodes b
               WHERE b.item_id = i.id AND b.deleted_at IS NULL
               ORDER BY b.barcode LIMIT 1)                       AS barcode,
              c.name                                             AS category,
              i.hsn_code          AS "hsnCode",
              i.unit,
              i.tax_rate_percent  AS "taxRatePercent",
              i.cess_rate_percent AS "cessRatePercent",
              i.mrp,
              i.sale_price        AS "salePrice",
              i.purchase_price    AS "purchasePrice",
              i.reorder_level     AS "reorderLevel",
              i.item_type         AS "itemType",
              i.track_stock       AS "trackStock"
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id AND c.deleted_at IS NULL
       WHERE i.deleted_at IS NULL AND ($1::boolean OR i.is_active)
       ORDER BY i.name, i.id
       LIMIT $2`,
      [includeInactive, limit],
    );
  },

  customers(tx: Tx, limit: number): Promise<ExportCustomerRow[]> {
    return tx.many<ExportCustomerRow>(
      `SELECT c.name, c.phone, c.email, c.gstin, c.state_code AS "stateCode",
              c.address_line1 AS "addressLine1", c.city, c.pincode,
              c.credit_limit AS "creditLimit",
              COALESCE(b.balance, 0) AS balance
       FROM customers c
       LEFT JOIN customer_balances b ON b.customer_id = c.id
       WHERE c.deleted_at IS NULL
       ORDER BY c.name, c.id
       LIMIT $1`,
      [limit],
    );
  },

  stock(tx: Tx, outletId: string, limit: number): Promise<ExportStockRow[]> {
    return tx.many<ExportStockRow>(
      `SELECT i.name, i.code, i.unit, sb.quantity, i.reorder_level AS "reorderLevel",
              i.purchase_price AS "purchasePrice"
       FROM stock_balances sb
       JOIN items i ON i.id = sb.item_id
       WHERE sb.outlet_id = $1 AND i.deleted_at IS NULL
       ORDER BY i.name, i.id
       LIMIT $2`,
      [outletId, limit],
    );
  },

  invoices(
    tx: Tx,
    filter: { from: string | undefined; to: string | undefined; outletId: string | undefined },
    restrictTo: readonly string[] | null,
    limit: number,
  ): Promise<ExportInvoiceRow[]> {
    return tx.many<ExportInvoiceRow>(
      `SELECT i.document_number AS "documentNumber", i.document_date AS "documentDate",
              i.customer_name AS "customerName", i.customer_gstin AS "customerGstin",
              i.taxable_amount AS "taxableAmount", i.total_cgst AS "totalCgst",
              i.total_sgst AS "totalSgst", i.total_igst AS "totalIgst", i.total_cess AS "totalCess",
              i.grand_total AS "grandTotal", i.status,
              COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                        JOIN payments p ON p.id = pa.payment_id
                        WHERE pa.invoice_id = i.id AND p.status = 'issued'), 0) AS "amountPaid"
       FROM invoices i
       WHERE ($1::date IS NULL OR i.document_date >= $1)
         AND ($2::date IS NULL OR i.document_date <= $2)
         AND ($3::uuid IS NULL OR i.outlet_id = $3)
         AND ($4::uuid[] IS NULL OR i.outlet_id = ANY($4::uuid[]))
       ORDER BY i.document_date, i.document_number
       LIMIT $5`,
      [
        filter.from ?? null,
        filter.to ?? null,
        filter.outletId ?? null,
        restrictTo ? [...restrictTo] : null,
        limit,
      ],
    );
  },

  /** Items to put on labels, by id, in the order the client asked for them. */
  labelItems(tx: Tx, itemIds: readonly string[]) {
    return tx.many<{
      itemId: string;
      name: string;
      unit: string;
      code: string | null;
      barcodes: string[];
      mrp: number | null;
      salePrice: number;
    }>(
      `SELECT i.id AS "itemId", i.name, i.unit, i.code, i.mrp, i.sale_price AS "salePrice",
              COALESCE((SELECT array_agg(b.barcode ORDER BY b.barcode) FROM item_barcodes b
                        WHERE b.item_id = i.id AND b.deleted_at IS NULL), '{}') AS barcodes
       FROM items i
       WHERE i.id = ANY($1::uuid[]) AND i.deleted_at IS NULL`,
      [[...itemIds]],
    );
  },
};
