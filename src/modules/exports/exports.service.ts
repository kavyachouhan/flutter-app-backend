/**
 * Spreadsheet export and barcode label payloads.
 *
 * Both are "take the shop's data out of the app" features and share a
 * module for that reason, but they leave by different doors: an export is a
 * file written to object storage and handed back as a signed URL, while a
 * label payload is JSON the device renders. Generating label PDFs server
 * side would need a barcode renderer and a PDF engine in the API, and would
 * still not drive an ESC/POS label printer, which takes commands rather
 * than pages.
 */
import { env } from '../../config/env.js';
import { withReadTransaction, type Tx } from '../../db/tx.js';
import { ITEM_COLUMNS } from '../../domain/import/item-columns.js';
import { resolveLabels } from '../../domain/labels/resolve.js';
import { LABEL_TEMPLATES, labelsPerPage } from '../../domain/labels/templates.js';
import { NotFoundError } from '../../lib/errors.js';
import { upload } from '../../lib/storage.js';
import { accessibleOutletIds, assertOutletAccess } from '../../middleware/authorize.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { exportsRepository } from './exports.repository.js';
import type { CreateExportBody, LabelPayloadBody } from './exports.schemas.js';
import {
  buildWorkbook,
  paiseToNumber,
  quantityToNumber,
  SPREADSHEET_CONTENT_TYPE,
  type SheetColumn,
  type SheetSpec,
} from './workbook.js';

/**
 * Bounded by the import limit rather than a figure of its own.
 *
 * The two are the same question — how many catalogue rows move in one
 * operation — and a shop that can import 50,000 rows should be able to get
 * them back out. A second knob would only ever be wrong relative to this one.
 */
const MAX_ROWS = env.IMPORT_MAX_ROWS;

/**
 * The items sheet, built from the importer's own column definitions.
 *
 * Headers are taken from `ITEM_COLUMNS` rather than written out again, so
 * export → edit → import round-trips by construction and not by vigilance.
 * `openingStock` is skipped: it is an import-only instruction, and a column
 * that silently re-applies an opening balance on every re-import would be a
 * quiet way to corrupt stock.
 */
const ROUND_TRIP_SKIP = new Set(['openingStock']);

function itemSheetColumns(): SheetColumn[] {
  return ITEM_COLUMNS.filter((column) => !ROUND_TRIP_SKIP.has(column.key)).map((column) => ({
    header: column.header,
    key: column.key,
    format:
      column.type === 'money'
        ? ('money' as const)
        : column.type === 'quantity'
          ? ('quantity' as const)
          : column.type === 'percent'
            ? ('number' as const)
            : ('text' as const),
  }));
}

export function itemExportHeaders(): string[] {
  return itemSheetColumns().map((column) => column.header);
}

async function itemsSheet(tx: Tx, includeInactive: boolean): Promise<SheetSpec> {
  const rows = await exportsRepository.items(tx, includeInactive, MAX_ROWS);
  return {
    name: 'Items',
    columns: itemSheetColumns(),
    rows: rows.map((row) => ({
      name: row.name,
      code: row.code,
      barcode: row.barcode,
      category: row.category,
      hsnCode: row.hsnCode,
      unit: row.unit,
      // NUMERIC arrives from pg as a string; written as a number so the
      // column sorts and sums in Excel.
      taxRatePercent: Number(row.taxRatePercent),
      cessRatePercent: Number(row.cessRatePercent),
      mrp: paiseToNumber(row.mrp),
      salePrice: paiseToNumber(row.salePrice),
      purchasePrice: paiseToNumber(row.purchasePrice),
      reorderLevel: quantityToNumber(row.reorderLevel),
      itemType: row.itemType === 'service' ? 'Service' : 'Goods',
      // Written the way the importer reads it back.
      trackStock: row.trackStock ? 'Yes' : 'No',
    })),
  };
}

async function customersSheet(tx: Tx): Promise<SheetSpec> {
  const rows = await exportsRepository.customers(tx, MAX_ROWS);
  return {
    name: 'Customers',
    columns: [
      { header: 'Name', key: 'name', format: 'text', width: 28 },
      { header: 'Phone', key: 'phone', format: 'text' },
      { header: 'Email', key: 'email', format: 'text', width: 24 },
      { header: 'GSTIN', key: 'gstin', format: 'text', width: 18 },
      { header: 'State code', key: 'stateCode', format: 'text' },
      { header: 'Address', key: 'addressLine1', format: 'text', width: 30 },
      { header: 'City', key: 'city', format: 'text' },
      { header: 'Pincode', key: 'pincode', format: 'text' },
      { header: 'Credit limit', key: 'creditLimit', format: 'money' },
      { header: 'Balance due', key: 'balance', format: 'money' },
    ],
    rows: rows.map((row) => ({
      ...row,
      creditLimit: paiseToNumber(row.creditLimit),
      balance: paiseToNumber(row.balance),
    })),
  };
}

async function stockSheet(tx: Tx, outletId: string): Promise<SheetSpec> {
  const rows = await exportsRepository.stock(tx, outletId, MAX_ROWS);
  return {
    name: 'Stock',
    columns: [
      { header: 'Name', key: 'name', format: 'text', width: 30 },
      { header: 'Code', key: 'code', format: 'text' },
      { header: 'Unit', key: 'unit', format: 'text' },
      { header: 'Quantity', key: 'quantity', format: 'quantity' },
      { header: 'Reorder level', key: 'reorderLevel', format: 'quantity' },
      { header: 'Purchase price', key: 'purchasePrice', format: 'money' },
      { header: 'Stock value', key: 'stockValue', format: 'money' },
    ],
    rows: rows.map((row) => ({
      name: row.name,
      code: row.code,
      unit: row.unit,
      quantity: quantityToNumber(row.quantity),
      reorderLevel: quantityToNumber(row.reorderLevel),
      purchasePrice: paiseToNumber(row.purchasePrice),
      // Valued at the item's purchase price, which is the only cost the
      // schema has until M11 introduces a moving average. It is a rough
      // figure and the column is named plainly rather than "cost of stock".
      stockValue:
        row.purchasePrice === null
          ? null
          : paiseToNumber(Math.round((row.purchasePrice * row.quantity) / 1000)),
    })),
  };
}

async function invoicesSheet(tx: Tx, body: CreateExportBody): Promise<SheetSpec> {
  const rows = await exportsRepository.invoices(
    tx,
    { from: body.from, to: body.to, outletId: body.outletId },
    accessibleOutletIds(),
    MAX_ROWS,
  );
  return {
    name: 'Invoices',
    columns: [
      { header: 'Invoice no.', key: 'documentNumber', format: 'text', width: 20 },
      { header: 'Date', key: 'documentDate', format: 'text' },
      { header: 'Customer', key: 'customerName', format: 'text', width: 28 },
      { header: 'Customer GSTIN', key: 'customerGstin', format: 'text', width: 18 },
      { header: 'Taxable', key: 'taxableAmount', format: 'money' },
      { header: 'CGST', key: 'totalCgst', format: 'money' },
      { header: 'SGST', key: 'totalSgst', format: 'money' },
      { header: 'IGST', key: 'totalIgst', format: 'money' },
      { header: 'Cess', key: 'totalCess', format: 'money' },
      { header: 'Total', key: 'grandTotal', format: 'money' },
      { header: 'Paid', key: 'amountPaid', format: 'money' },
      { header: 'Balance', key: 'balance', format: 'money' },
      { header: 'Status', key: 'status', format: 'text' },
    ],
    rows: rows.map((row) => ({
      documentNumber: row.documentNumber,
      documentDate: String(row.documentDate),
      customerName: row.customerName,
      customerGstin: row.customerGstin,
      taxableAmount: paiseToNumber(row.taxableAmount),
      totalCgst: paiseToNumber(row.totalCgst),
      totalSgst: paiseToNumber(row.totalSgst),
      totalIgst: paiseToNumber(row.totalIgst),
      totalCess: paiseToNumber(row.totalCess),
      grandTotal: paiseToNumber(row.grandTotal),
      amountPaid: paiseToNumber(row.amountPaid),
      balance: paiseToNumber(row.grandTotal - row.amountPaid),
      status: row.status === 'void' ? 'Void' : 'Issued',
    })),
  };
}

/**
 * Builds the workbook, stores it, and returns a link.
 *
 * Synchronous, like the importer's phases, and for the same reason: the work
 * is seconds, and the alternative is a job table whose only job would be to
 * hold a URL. The storage round trip happens outside the transaction so a
 * pooled connection is not held across a network call.
 */
export async function createExport(body: CreateExportBody) {
  if (body.outletId) assertOutletAccess(body.outletId);

  const { sheet, rowCount, filename } = await withReadTransaction(async (tx) => {
    await assertFeature(tx, 'bulk_edit');

    const built = await buildSheet(tx, body);
    return {
      sheet: built,
      rowCount: built.rows.length,
      filename: `${body.kind}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    };
  });

  const buffer = await buildWorkbook([sheet]);
  const objectKey = await upload('export', SPREADSHEET_CONTENT_TYPE, buffer);

  return {
    objectKey,
    filename,
    kind: body.kind,
    rowCount,
    /** True when the sweep hit the cap and the file is therefore partial. */
    truncated: rowCount >= MAX_ROWS,
    sizeBytes: buffer.byteLength,
  };
}

function buildSheet(tx: Tx, body: CreateExportBody): Promise<SheetSpec> {
  switch (body.kind) {
    case 'items':
      return itemsSheet(tx, body.includeInactive);
    case 'customers':
      return customersSheet(tx);
    case 'stock':
      // The schema guarantees this is present for a stock export.
      return stockSheet(tx, body.outletId as string);
    case 'invoices':
      return invoicesSheet(tx, body);
  }
}

// ---------------------------------------------------------------------------
// Barcode labels
// ---------------------------------------------------------------------------

export function listLabelTemplates() {
  return Object.values(LABEL_TEMPLATES).map((template) => ({
    ...template,
    labelsPerPage: labelsPerPage(template),
  }));
}

export function buildLabelPayload(body: LabelPayloadBody) {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'barcode_printing');

    const tenant = await tenantsRepository.findCurrent(tx);
    if (!tenant) throw new NotFoundError('Tenant');

    const template = LABEL_TEMPLATES[body.templateKey];
    const requested = body.items.map((i) => i.itemId);
    const found = new Map(
      (await exportsRepository.labelItems(tx, requested)).map((row) => [row.itemId, row]),
    );

    const missing = requested.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundError('Item', { details: { itemIds: missing } });
    }

    // Kept in the order the client asked for, which is the order they chose
    // on screen, rather than whatever the database returned.
    const items = body.items.map((requestedItem) => {
      const row = found.get(requestedItem.itemId);
      if (!row) throw new NotFoundError('Item');
      return {
        item: {
          itemId: row.itemId,
          name: row.name,
          unit: row.unit,
          code: row.code,
          barcodes: row.barcodes,
          mrp: row.mrp,
          salePrice: row.salePrice,
        },
        copies: requestedItem.copies,
      };
    });

    const resolved = resolveLabels({
      items,
      template,
      priceField: body.priceField,
      currencySymbol: tenant.currencySymbol,
    });

    const perPage = labelsPerPage(template);
    return {
      template: { ...template, labelsPerPage: perPage },
      ...resolved,
      pages: perPage === null ? null : Math.ceil(resolved.totalLabels / perPage),
    };
  });
}
