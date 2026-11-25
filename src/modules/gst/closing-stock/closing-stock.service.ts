/**
 * Closing-stock ITC statement for a registration on a date (Rule 44): the figures for GSTR-10
 * Table 8, REG-16 Table 10 or ITC-03. A report: nothing is stored or filed from here.
 */
import { withReadTransaction } from '../../../db/tx.js';
import {
  closingStockItc,
  type CapitalGood,
  type PurchaseLot,
  type StockHolding,
} from '../../../domain/gst/closing-stock.js';
import { col, makeSheet } from '../../../domain/gst/returns/sheets.js';
import { assertFeature } from '../../entitlements/entitlements.js';

const n = (v: unknown) => Number(v ?? 0);
const tax = (r: Record<string, unknown>) => ({ igst: n(r['igst']), cgst: n(r['cgst']), sgst: n(r['sgst']), cess: n(r['cess']) });

export function closingStockStatement(gstin: string, asOf: string) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    // Stock held by the registration's outlets at the end of `asOf`.
    const holdings = await tx.many<Record<string, unknown>>(
      `SELECT s.item_id AS "itemId", i.name AS "itemName", i.hsn_code AS hsn, SUM(s.quantity_delta) AS quantity
       FROM stock_ledger_entries s
       JOIN items i ON i.id = s.item_id
       JOIN outlets o ON o.id = s.outlet_id
       JOIN gst_registrations r ON r.id = o.registration_id AND r.gstin = $1
       WHERE s.occurred_at < ($2::date + 1)
       GROUP BY s.item_id, i.name, i.hsn_code
       HAVING SUM(s.quantity_delta) > 0`,
      [gstin, asOf],
    );
    // Purchases on which credit was taken (eligible, not void), line by line.
    const lots = await tx.many<Record<string, unknown>>(
      `SELECT l.item_id AS "itemId", b.supplier_invoice_no AS "billNumber", b.supplier_gstin AS "supplierGstin",
              b.supplier_invoice_date::text AS date, l.quantity, l.igst, l.cgst, l.sgst, l.cess
       FROM purchase_bill_lines l
       JOIN purchase_bills b ON b.id = l.purchase_bill_id
       LEFT JOIN gst_registrations reg ON reg.id = b.registration_id
       WHERE b.status <> 'void' AND b.itc_eligible AND b.itc_category <> 'capital_goods'
         AND NOT b.is_reverse_charge AND (reg.gstin IS NULL OR reg.gstin = $1)
         AND b.supplier_invoice_date <= $2::date AND l.item_id IS NOT NULL`,
      [gstin, asOf],
    );
    const capital = await tx.many<Record<string, unknown>>(
      `SELECT r.id AS "registerId", COALESCE(b.supplier_invoice_no, '') AS "billNumber", r.supplier_gstin AS "supplierGstin",
              r.document_date::text AS date, r.igst, r.cgst, r.sgst, r.cess
       FROM itc_register r
       JOIN purchase_bills b ON r.source_type = 'purchase_bill' AND b.id = r.source_id
       WHERE r.gstin = $1 AND r.itc_category = 'capital_goods' AND r.state <> 'reversed'
         AND r.document_date <= $2::date`,
      [gstin, asOf],
    );
    const result = closingStockItc(
      asOf,
      holdings.map((h): StockHolding => ({
        itemId: String(h['itemId']),
        itemName: String(h['itemName']),
        hsn: (h['hsn'] as string | null) ?? null,
        quantity: n(h['quantity']),
      })),
      lots.map((l): PurchaseLot => ({
        itemId: String(l['itemId']),
        billNumber: String(l['billNumber']),
        supplierGstin: (l['supplierGstin'] as string | null) ?? null,
        date: String(l['date']),
        quantity: n(l['quantity']),
        tax: tax(l),
      })),
      capital.map((c): CapitalGood => ({
        registerId: String(c['registerId']),
        billNumber: String(c['billNumber']),
        supplierGstin: (c['supplierGstin'] as string | null) ?? null,
        date: String(c['date']),
        tax: tax(c),
      })),
    );
    const money = (k: string, l: string) => col(k, l, 'money', true);
    const taxCols = [money('igst', 'IGST'), money('cgst', 'CGST'), money('sgst', 'SGST'), money('cess', 'Cess')];
    const sheets = [
      makeSheet(
        'stock_inputs',
        'Inputs held in stock, semi-finished and finished goods (with invoices)',
        [col('item', 'Item'), col('hsn', 'HSN'), col('quantity', 'Quantity', 'quantity'), col('invoices', 'Purchase invoices'), ...taxCols],
        result.inputs.map((r) => ({ item: r.itemName, hsn: r.hsn, quantity: r.matchedQuantity, invoices: r.invoices.join(', '), ...r.tax })),
        { note: 'Rule 44(1)(a): ITC in proportion to the latest purchase invoices covering the stock.' },
      ),
      makeSheet(
        'stock_without_invoices',
        'Stock without purchase invoices (Rule 44(3))',
        [col('item', 'Item'), col('hsn', 'HSN'), col('quantity', 'Quantity', 'quantity')],
        result.withoutInvoices.map((r) => ({ item: r.itemName, hsn: r.hsn, quantity: r.quantity })),
        { note: 'Estimate at the prevailing market price; the figures must be certified by a chartered or cost accountant (Rule 44(3), (5)).' },
      ),
      makeSheet(
        'capital_goods',
        'Capital goods (remaining useful life)',
        [col('bill', 'Invoice'), col('supplier', 'Supplier GSTIN'), col('date', 'Date', 'date'), col('months', 'Months left of 60', 'number'), ...taxCols],
        result.capitalGoods.map((r) => ({ bill: r.billNumber, supplier: r.supplierGstin, date: r.date, months: r.remainingMonths, ...r.tax })),
        { note: 'Rule 44(1)(b): ITC x remaining months / 60, ignoring part of a month.' },
      ),
    ];
    return {
      asOf,
      gstin,
      total: result.total,
      sheets,
      notes: [
        'For GSTR-10 Table 8 (s.29(5), Rule 81), REG-16 Table 10 (from 01.12.2026) or ITC-03 (s.18(4)).',
        'Under s.29(5) the amount payable is the higher of this credit and the output tax on the goods; the output tax is not worked out here.',
      ],
    };
  });
}
