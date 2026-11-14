/**
 * Hands a prepared return over: as an Excel workbook, as portal JSON, or as a CA package.
 *
 * Everything is rendered from the *snapshotted* workings, never recomputed: the file an accountant
 * was given last week and the figures on screen today have to be the same thing, or nobody can
 * tell which was filed. The sheets, the neutral model and the issues all live in that snapshot,
 * which is what keeps the screen, the Excel file, the PDF the app draws, the JSON and the CA
 * package identical.
 *
 * Portal JSON is produced by a versioned mapper and validated against the official schema; a file
 * that fails validation is refused with the reasons, and a mapper not built from the official
 * request schema is labelled draft. Nothing here is ever called "portal compatible" on its own
 * say-so.
 */
import { withReadTransaction } from '../../db/tx.js';
import type { Gstr1Return, Gstr3bReturn, Gstr9Return } from '../../domain/gst/returns/model.js';
import type { Sheet, WorkingIssue } from '../../domain/gst/returns/sheets.js';
import { NotFoundError, UnprocessableError, ErrorCode } from '../../lib/errors.js';
import { upload } from '../../lib/storage.js';
import {
  buildWorkbook,
  paiseToNumber,
  SPREADSHEET_CONTENT_TYPE,
  type SheetSpec,
} from '../exports/workbook.js';
import { issueSheet, sheetName, toSheetSpec } from './sheet-workbook.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { gstRepository, type GstReturnPeriodRow } from './gst.repository.js';
import { itcRepository } from './itc.repository.js';
import { exportPayload } from './returns/payload-export.js';

const JSON_CONTENT_TYPE = 'application/json';

type Row = Record<string, unknown>;

/** A stored return sheet as a workbook sheet; GSTR-1's b2b sheet keeps the offline tool's name. */
const periodSheetSpec = (sheet: Sheet, used: Set<string>) =>
  toSheetSpec(sheet, used, sheet.id === 'b2b' ? 'b2b,sez,de' : sheet.id);

interface StoredWorkings {
  form: 'gstr1' | 'gstr3b' | 'gstr9';
  sheets: Sheet[];
  issues: WorkingIssue[];
  summary: {
    key: string;
    label: string;
    records: number;
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  }[];
  model: Gstr1Return | Gstr3bReturn | Gstr9Return;
}

function requireStored(period: GstReturnPeriodRow): StoredWorkings {
  const w = period.workings as unknown as Partial<StoredWorkings> | null;
  if (!w || !Array.isArray(w.sheets) || !w.model) {
    throw new UnprocessableError(
      'This return was prepared with an older version. Prepare it again, then export.',
      ErrorCode.UNPROCESSABLE,
    );
  }
  return w as StoredWorkings;
}

export interface GstExportResult {
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  /** For JSON: how far the file can be trusted. */
  readonly payloadStatus?: 'portal_ready' | 'draft' | 'draft_partial';
  readonly mapperId?: string;
  readonly schemaSha256?: string;
  /** Sections or problems the user must know about before using the file. */
  readonly issues?: readonly { severity: string; code: string; message: string; path?: string }[];
}

export type ExportFormat = 'xlsx' | 'json' | 'ca';

export async function exportPeriod(
  id: string,
  format: ExportFormat,
  options: { acceptUnsupported?: boolean } = {},
): Promise<GstExportResult> {
  const { period, itc } = await withReadTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const row = await gstRepository.findPeriod(tx, id);
    if (!row) throw new NotFoundError('GST return period');
    // Nothing to hand over until it has been computed: an empty file would look like a return
    // with no supplies in it.
    if (row.status === 'open' || !row.workings) {
      throw new UnprocessableError(
        'Prepare this return before exporting it.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    const itcRows =
      format === 'ca' && row.returnType === 'gstr3b'
        ? await itcRepository.list(
            tx,
            {
              gstin: row.gstin,
              from: row.periodFrom,
              to: row.periodTo,
              state: undefined,
              itcCategory: undefined,
              supplierId: undefined,
            },
            5000,
            undefined,
          )
        : [];
    return { period: row, itc: itcRows };
  });

  const label = `${period.returnType}-${period.gstin}-${period.periodYear}-${String(
    period.periodMonth,
  ).padStart(2, '0')}`;

  if (period.returnType === 'cmp08') {
    if (format === 'json') {
      throw new UnprocessableError(
        'No official schema has been supplied for CMP-08, so no portal JSON is produced.',
        ErrorCode.UNPROCESSABLE,
      );
    }
    const buffer = await buildWorkbook(cmp08Sheets(period));
    const objectKey = await upload('export', SPREADSHEET_CONTENT_TYPE, buffer);
    return { objectKey, filename: `${label}.xlsx`, contentType: SPREADSHEET_CONTENT_TYPE };
  }

  const stored = requireStored(period);

  if (format === 'json') {
    const exported = exportPayload(period.returnType, stored.model, {
      year: period.periodYear,
      month: period.periodMonth,
    });
    const blocking = exported.issues.filter((i) => i.severity === 'error');
    const onlyUnsupported = blocking.every((i) => i.code === 'section_unsupported');
    if (blocking.length > 0 && !(options.acceptUnsupported && onlyUnsupported)) {
      throw new UnprocessableError(
        'The portal file cannot be produced as it stands.',
        ErrorCode.UNPROCESSABLE,
        { details: { mapperId: exported.mapperId, issues: exported.issues } },
      );
    }
    const partial = blocking.length > 0;
    const buffer = Buffer.from(JSON.stringify(exported.payload, null, 2), 'utf8');
    const objectKey = await upload('export', JSON_CONTENT_TYPE, buffer);
    return {
      objectKey,
      filename: `${label}${partial ? '-partial-DRAFT' : exported.portalReady ? '' : '-DRAFT'}.json`,
      contentType: JSON_CONTENT_TYPE,
      payloadStatus: partial ? 'draft_partial' : exported.portalReady ? 'portal_ready' : 'draft',
      mapperId: exported.mapperId,
      schemaSha256: exported.schemaSha256,
      issues: exported.issues,
    };
  }

  const used = new Set<string>();
  const sheets: SheetSpec[] = [];

  if (format === 'ca') {
    sheets.push(summarySheet(period, stored, used));
    used.add('Issues');
  }
  for (const s of stored.sheets) sheets.push(periodSheetSpec(s, used));
  if (format === 'ca') {
    sheets.push(issueSheet(stored.issues));
    if (period.returnType === 'gstr3b') sheets.push(itcSheet(itc, used));
  }

  const buffer = await buildWorkbook(sheets);
  const objectKey = await upload('export', SPREADSHEET_CONTENT_TYPE, buffer);
  return {
    objectKey,
    filename: `${label}${format === 'ca' ? '-CA-package' : ''}.xlsx`,
    contentType: SPREADSHEET_CONTENT_TYPE,
  };
}

function summarySheet(period: GstReturnPeriodRow, w: StoredWorkings, used: Set<string>): SheetSpec {
  used.add('Summary');
  const rows: Row[] = [
    { item: 'Return', value: period.returnType.toUpperCase() },
    { item: 'GSTIN', value: period.gstin },
    {
      item: 'Period',
      value: `${String(period.periodMonth).padStart(2, '0')}-${period.periodYear}`,
    },
    { item: 'Prepared at', value: period.preparedAt ? period.preparedAt.toISOString() : '' },
    { item: 'Status', value: period.status },
    { item: 'Issues to review', value: w.issues.filter((i) => i.severity !== 'info').length },
    { item: '', value: '' },
    ...w.summary.map((s) => ({
      item: s.label,
      value: `records ${s.records}; taxable ${(paiseToNumber(s.taxable) ?? 0).toFixed(2)}; IGST ${(paiseToNumber(s.igst) ?? 0).toFixed(2)}; CGST ${(paiseToNumber(s.cgst) ?? 0).toFixed(2)}; SGST ${(paiseToNumber(s.sgst) ?? 0).toFixed(2)}; cess ${(paiseToNumber(s.cess) ?? 0).toFixed(2)}`,
    })),
  ];
  return {
    name: 'Summary',
    columns: [
      { header: 'Item', key: 'item', format: 'text', width: 40 },
      { header: 'Value', key: 'value', format: 'text', width: 110 },
    ],
    rows,
  };
}

function itcSheet(
  rows: readonly {
    documentDate: string;
    supplierGstin: string | null;
    itcCategory: string;
    isReverseCharge: boolean;
    state: string;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
    taxableAmount: number;
  }[],
  used: Set<string>,
): SheetSpec {
  return {
    name: sheetName('ITC register', used),
    columns: [
      { header: 'Date', key: 'date', format: 'date' },
      { header: 'Supplier GSTIN', key: 'gstin', format: 'text', width: 18 },
      { header: 'Category', key: 'category', format: 'text', width: 16 },
      { header: 'Reverse charge', key: 'rcm', format: 'text' },
      { header: 'State', key: 'state', format: 'text' },
      { header: 'Taxable', key: 'taxable', format: 'money' },
      { header: 'IGST', key: 'igst', format: 'money' },
      { header: 'CGST', key: 'cgst', format: 'money' },
      { header: 'SGST', key: 'sgst', format: 'money' },
      { header: 'Cess', key: 'cess', format: 'money' },
    ],
    rows: rows.map((r) => ({
      date: r.documentDate,
      gstin: r.supplierGstin ?? '',
      category: r.itcCategory,
      rcm: r.isReverseCharge ? 'Y' : 'N',
      state: r.state,
      taxable: paiseToNumber(r.taxableAmount),
      igst: paiseToNumber(r.igst),
      cgst: paiseToNumber(r.cgst),
      sgst: paiseToNumber(r.sgst),
      cess: paiseToNumber(r.cess),
    })),
  };
}

/** CMP-08 is a small summary: one sheet of label-and-figure rows. */
function cmp08Sheets(period: GstReturnPeriodRow): SheetSpec[] {
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
      name: 'CMP-08',
      columns: [
        { header: 'Item', key: 'label', format: 'text', width: 40 },
        { header: 'Amount', key: 'value', format: 'money' },
      ],
      rows,
    },
  ];
}
