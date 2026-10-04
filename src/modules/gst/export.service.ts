/**
 * Hands a prepared return over: as a workbook an accountant reads, or as the
 * JSON the GST portal's offline tool uploads.
 *
 * Reads the *snapshotted* workings, never recomputing. That is the whole point
 * of snapshotting them: the file an accountant was given last week and the
 * figures on screen today have to be the same thing, or nobody can tell which
 * was filed.
 *
 * Synchronous, like the spreadsheet exporter, and for the same reason: the work
 * is a second, and the alternative is a job table whose only job is to hold a
 * URL. The storage round trip happens after the transaction closes, so a
 * pooled connection is never held across a network call.
 */
import { withReadTransaction } from '../../db/tx.js';
import { NotFoundError, UnprocessableError, ErrorCode } from '../../lib/errors.js';
import { upload } from '../../lib/storage.js';
import {
  buildWorkbook,
  paiseToNumber,
  quantityToNumber,
  SPREADSHEET_CONTENT_TYPE,
  type SheetColumn,
  type SheetSpec,
} from '../exports/workbook.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { gstRepository, type GstReturnPeriodRow } from './gst.repository.js';

const JSON_CONTENT_TYPE = 'application/json';

type Row = Record<string, unknown>;

const text = (header: string, key: string, width?: number): SheetColumn => ({
  header,
  key,
  format: 'text',
  ...(width === undefined ? {} : { width }),
});
const money = (header: string, key: string): SheetColumn => ({ header, key, format: 'money' });
const date = (header: string, key: string): SheetColumn => ({ header, key, format: 'date' });
const qty = (header: string, key: string): SheetColumn => ({ header, key, format: 'quantity' });

/** The columns every itemised outward table shares, in the portal's own order. */
const ITEMISED_COLUMNS: SheetColumn[] = [
  text('GSTIN of recipient', 'customerGstin', 18),
  text('Receiver name', 'customerName', 24),
  text('Invoice number', 'documentNumber', 16),
  date('Invoice date', 'documentDate'),
  money('Invoice value', 'invoiceValue'),
  text('Place of supply', 'placeOfSupply'),
  text('Reverse charge', 'reverseCharge'),
  money('Taxable value', 'taxableAmount'),
  money('CGST', 'cgst'),
  money('SGST', 'sgst'),
  money('IGST', 'igst'),
  money('Cess', 'cess'),
];

function itemisedRows(rows: unknown): Row[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((value) => {
    const row = value as Row;
    return {
      customerGstin: row['customerGstin'] ?? '',
      customerName: row['customerName'] ?? '',
      documentNumber: row['documentNumber'],
      documentDate: row['documentDate'],
      invoiceValue: paiseToNumber(row['invoiceValue'] as number),
      placeOfSupply: row['placeOfSupply'] ?? '',
      // 'Y'/'N' rather than true/false: that is what the portal's template
      // expects, and an accountant transcribing by hand reads it the same way.
      reverseCharge: row['isReverseCharge'] === true ? 'Y' : 'N',
      taxableAmount: paiseToNumber(row['taxableAmount'] as number),
      cgst: paiseToNumber(row['cgst'] as number),
      sgst: paiseToNumber(row['sgst'] as number),
      igst: paiseToNumber(row['igst'] as number),
      cess: paiseToNumber(row['cess'] as number),
      ...(row['originalDocumentNumber']
        ? { originalDocumentNumber: row['originalDocumentNumber'] }
        : {}),
    };
  });
}

/**
 * One sheet per GSTR-1 table.
 *
 * `buildWorkbook` has always taken a list of sheets and every caller so far
 * passed one; a return is what it was built for. Empty tables are included
 * rather than dropped, because an accountant checking a return needs to see
 * that a table is empty, not wonder whether it was computed.
 */
function gstr1Sheets(workings: Record<string, unknown>): SheetSpec[] {
  const b2cs = Array.isArray(workings['b2cs']) ? (workings['b2cs'] as Row[]) : [];
  const nilExempt = Array.isArray(workings['nilExemptNonGst'])
    ? (workings['nilExemptNonGst'] as Row[])
    : [];
  const hsn = Array.isArray(workings['hsnSummary']) ? (workings['hsnSummary'] as Row[]) : [];
  const issued = Array.isArray(workings['documentsIssued'])
    ? (workings['documentsIssued'] as Row[])
    : [];

  const cdnColumns: SheetColumn[] = [
    ...ITEMISED_COLUMNS,
    text('Original invoice number', 'originalDocumentNumber', 16),
  ];

  return [
    { name: 'B2B', columns: ITEMISED_COLUMNS, rows: itemisedRows(workings['b2b']) },
    { name: 'B2CL', columns: ITEMISED_COLUMNS, rows: itemisedRows(workings['b2cl']) },
    {
      name: 'B2CS',
      columns: [
        text('Place of supply', 'placeOfSupply'),
        { header: 'Rate', key: 'taxRatePercent', format: 'number' },
        money('Taxable value', 'taxableAmount'),
      ],
      rows: b2cs.map((row) => ({
        placeOfSupply: row['placeOfSupply'],
        taxRatePercent: row['taxRatePercent'],
        taxableAmount: paiseToNumber(row['taxableAmount'] as number),
      })),
    },
    { name: 'EXP', columns: ITEMISED_COLUMNS, rows: itemisedRows(workings['exports']) },
    { name: 'SEZ', columns: ITEMISED_COLUMNS, rows: itemisedRows(workings['sez']) },
    { name: 'CDNR', columns: cdnColumns, rows: itemisedRows(workings['cdnr']) },
    { name: 'CDNUR', columns: cdnColumns, rows: itemisedRows(workings['cdnur']) },
    {
      name: 'Nil-Exempt-NonGST',
      columns: [
        text('Classification', 'supplyCategory'),
        text('Supply type', 'supplyType'),
        money('Taxable value', 'taxableAmount'),
      ],
      rows: nilExempt.map((row) => ({
        supplyCategory: row['supplyCategory'],
        supplyType: row['supplyType'],
        taxableAmount: paiseToNumber(row['taxableAmount'] as number),
      })),
    },
    {
      name: 'HSN',
      columns: [
        text('HSN', 'hsnCode'),
        text('UQC', 'unit'),
        qty('Total quantity', 'quantity'),
        money('Taxable value', 'taxableAmount'),
        money('CGST', 'cgst'),
        money('SGST', 'sgst'),
        money('IGST', 'igst'),
        money('Cess', 'cess'),
      ],
      rows: hsn.map((row) => ({
        hsnCode: row['hsnCode'],
        unit: row['unit'] ?? '',
        quantity: quantityToNumber(row['quantity'] as number),
        taxableAmount: paiseToNumber(row['taxableAmount'] as number),
        cgst: paiseToNumber(row['cgst'] as number),
        sgst: paiseToNumber(row['sgst'] as number),
        igst: paiseToNumber(row['igst'] as number),
        cess: paiseToNumber(row['cess'] as number),
      })),
    },
    {
      name: 'Documents',
      columns: [
        text('Document type', 'documentType'),
        text('From', 'fromNo'),
        text('To', 'toNo'),
        { header: 'Issued', key: 'issued', format: 'number' },
      ],
      rows: issued,
    },
  ];
}

/** GSTR-3B and CMP-08 are summaries, so one sheet of label-and-figure rows. */
function summarySheets(period: GstReturnPeriodRow): SheetSpec[] {
  const workings = period.workings ?? {};
  const rows: Row[] = [];

  const push = (label: string, value: unknown) => {
    rows.push({ label, value: typeof value === 'number' ? paiseToNumber(value) : value });
  };

  const flatten = (prefix: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') {
      push(prefix, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => flatten(`${prefix}[${index}]`, entry));
      return;
    }
    for (const [key, nested] of Object.entries(value as Row)) {
      flatten(prefix ? `${prefix} / ${key}` : key, nested);
    }
  };

  flatten('', workings);
  return [
    {
      name: period.returnType === 'cmp08' ? 'CMP-08' : 'GSTR-3B',
      columns: [text('Item', 'label', 40), money('Amount', 'value')],
      rows,
    },
  ];
}

export interface GstExportResult {
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
}

export async function exportPeriod(
  id: string,
  format: 'xlsx' | 'json',
): Promise<GstExportResult> {
  const period = await withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const row = await gstRepository.findPeriod(tx, id);
    if (!row) throw new NotFoundError('GST return period');
    // Nothing to hand over until it has been computed, and inventing an empty
    // file would look like a return with no supplies in it.
    if (row.status === 'open' || !row.workings) {
      throw new UnprocessableError(
        'Prepare this return before exporting it.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    return row;
  });

  const label = `${period.returnType}-${period.gstin}-${period.periodYear}-${String(
    period.periodMonth,
  ).padStart(2, '0')}`;

  if (format === 'json') {
    // The workings as stored, wrapped with the identifying header the portal's
    // offline tool expects. Deliberately not reshaped into the portal's
    // abbreviated keys: that mapping belongs with a filing integration that
    // can be tested against the API, and inventing it here would produce a
    // file that looks official and may not upload.
    const payload = {
      gstin: period.gstin,
      ret_period: `${String(period.periodMonth).padStart(2, '0')}${period.periodYear}`,
      return_type: period.returnType,
      prepared_at: period.preparedAt,
      workings: period.workings,
    };
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const objectKey = await upload('export', JSON_CONTENT_TYPE, buffer);
    return { objectKey, filename: `${label}.json`, contentType: JSON_CONTENT_TYPE };
  }

  const sheets =
    period.returnType === 'gstr1' ? gstr1Sheets(period.workings ?? {}) : summarySheets(period);
  const buffer = await buildWorkbook(sheets);
  const objectKey = await upload('export', SPREADSHEET_CONTENT_TYPE, buffer);
  return { objectKey, filename: `${label}.xlsx`, contentType: SPREADSHEET_CONTENT_TYPE };
}
