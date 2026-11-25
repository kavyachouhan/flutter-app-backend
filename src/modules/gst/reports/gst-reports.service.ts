/**
 * GSTR transaction reports: the GSTR-1 sales and credit/debit note tables and the GSTR-2 purchase
 * register, for one month and registration, as an Excel workbook.
 *
 * Nothing here calculates anything new. Sales and notes come from the same GSTR-1 engine the
 * prepared return uses (run live over the current documents); purchases come from the purchase
 * register engine. These are "what would this month look like now" workbooks and are not
 * snapshotted, so they do not replace preparing a return.
 */
import { withTransaction } from '../../../db/tx.js';
import { buildHsnSales, buildSacReport } from '../../../domain/gst/returns/hsn-summary.js';
import { buildPurchaseRegister } from '../../../domain/gst/returns/purchase-register.js';
import type { Sheet, WorkingIssue } from '../../../domain/gst/returns/sheets.js';
import { requireAuthContext } from '../../../lib/context.js';
import { createLogger } from '../../../lib/logger.js';
import { upload } from '../../../lib/storage.js';
import { recordAudit } from '../../audit/audit.js';
import { assertFeature } from '../../entitlements/entitlements.js';
import { buildWorkbook, SPREADSHEET_CONTENT_TYPE, type SheetSpec } from '../../exports/workbook.js';
import { periodWindow } from '../period-window.js';
import { resolveGstin } from '../gstin-scope.js';
import { issueSheet, toSheetSpec } from '../sheet-workbook.js';
import { computeGstr1 } from '../returns/returns.service.js';
import { returnsRepository } from '../returns/returns.repository.js';
import type {
  HsnSalesQuery,
  SacQuery,
  TransactionKind,
  TransactionReportQuery,
} from './gst-reports.schemas.js';

const log = createLogger('gst-reports');

/** Offline-tool sheet names, so the workbook reads like the template an accountant knows. */
const SHEET_NAME: Readonly<Record<string, string>> = {
  b2b: 'b2b',
  b2cl: 'b2cl',
  b2cs: 'b2cs',
  exp: 'exp',
  exemp: 'exemp',
  hsn_b2b: 'hsn(b2b)',
  hsn_b2c: 'hsn(b2c)',
  docs: 'docs',
  cdnr: 'cdnr',
  cdnur: 'cdnur',
  b2bur: 'b2bur',
  imps: 'imps',
  impg: 'impg',
  hsnsum: 'hsnsum',
};

const SALES_SHEETS = ['b2b', 'b2cl', 'b2cs', 'exp', 'exemp', 'hsn_b2b', 'hsn_b2c', 'docs'];
const CDN_SHEETS = ['cdnr', 'cdnur'];
const PURCHASE_SHEETS = ['b2b', 'b2bur', 'imps', 'impg', 'exemp', 'hsnsum'];

const FILE_LABEL: Readonly<Record<TransactionKind, string>> = {
  gstr1_sales: 'GSTR1-Sales',
  gstr1_cdn: 'GSTR1-CDN',
  gstr2_purchases: 'GSTR2-Purchases',
  gstr2_cdn: 'GSTR2-CDN',
};

export interface TransactionReportResult {
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly kind: TransactionKind;
  readonly gstin: string;
  readonly rows: number;
  readonly issues: readonly WorkingIssue[];
}

/** The sheets of a report, in workbook order. */
function pick(sheets: readonly Sheet[], ids: readonly string[]): Sheet[] {
  return ids
    .map((id) => sheets.find((s) => s.id === id))
    .filter((s): s is Sheet => s !== undefined);
}

export function exportTransactionReport(
  query: TransactionReportQuery,
): Promise<TransactionReportResult> {
  const auth = requireAuthContext();
  const includeNonTax = query.excludeNonTax === 'false';

  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const gstin = await resolveGstin(tx, query.gstin);
    // Monthly window; a quarterly (QRMP) filer's quarter is honoured by the same helper.
    const window = await periodWindow(tx, 'gstr1', query.year, query.month);
    const bounds = {
      gstin,
      period: { year: query.year, month: query.month },
      from: window.from,
      to: window.to,
    };

    let sheets: Sheet[];
    let issues: WorkingIssue[];
    if (query.kind === 'gstr1_sales' || query.kind === 'gstr1_cdn') {
      const w = await computeGstr1(tx, bounds, { excludeEinvoiceFromPortal: false, includeNonTax });
      const ids = query.kind === 'gstr1_sales' ? SALES_SHEETS : CDN_SHEETS;
      sheets = pick(w.sheets, includeNonTax ? ids : ids.filter((id) => id !== 'exemp'));
      // Issues that belong to the sections shown, plus the ones that apply to every table.
      issues = [...w.issues];
    } else {
      const docs = await returnsRepository.inwardDocuments(tx, gstin, window.from, window.to);
      const register = buildPurchaseRegister({ docs, includeNonTax });
      sheets = pick(
        register.sheets,
        query.kind === 'gstr2_purchases' ? PURCHASE_SHEETS : CDN_SHEETS,
      );
      issues = [...register.issues];
    }

    const used = new Set<string>(['Issues']);
    const specs: SheetSpec[] = sheets.map((s) =>
      toSheetSpec(s, used, SHEET_NAME[s.id] ?? s.id),
    );
    specs.push(issueSheet(issues));
    const rows = sheets.reduce((n, s) => n + s.rows.length, 0);

    const buffer = await buildWorkbook(specs);
    const objectKey = await upload('export', SPREADSHEET_CONTENT_TYPE, buffer);
    const period = `${query.year}-${String(query.month).padStart(2, '0')}`;
    const filename = `${FILE_LABEL[query.kind]}-${gstin}-${period}.xlsx`;

    await recordAudit(tx, {
      action: 'gst_report.exported',
      entityType: 'gst_report',
      metadata: { kind: query.kind, gstin, period, rows, includeNonTax },
    });
    log.info(
      { kind: query.kind, gstin, period, rows, issues: issues.length, userId: auth.userId },
      'GST transaction report exported',
    );

    return {
      objectKey,
      filename,
      contentType: SPREADSHEET_CONTENT_TYPE,
      kind: query.kind,
      gstin,
      rows,
      issues,
    };
  });
}

// --- Table reports: Sales Summary by HSN and the SAC report ----------------------------------

/** The on-screen form of a table report; the same shape the app reads a prepared return in. */
export interface TableReport {
  readonly form: 'hsn_sales' | 'sac';
  readonly gstin: string;
  readonly from: string;
  readonly to: string;
  readonly sheets: readonly Sheet[];
  readonly summary: readonly never[];
  readonly issues: readonly WorkingIssue[];
}

export type TableReportOutput =
  | { readonly kind: 'json'; readonly report: TableReport }
  | {
      readonly kind: 'file';
      readonly objectKey: string;
      readonly filename: string;
      readonly contentType: string;
      readonly report: TableReport;
    };

/** A CA-friendly cover sheet: what the file is, for whom, when, and how much to double-check. */
function coverSheet(title: string, report: TableReport, extra: readonly [string, string][]): SheetSpec {
  const problems = report.issues.filter((i) => i.severity !== 'info').length;
  return {
    name: 'Summary',
    columns: [
      { header: 'Item', key: 'item', format: 'text', width: 30 },
      { header: 'Value', key: 'value', format: 'text', width: 60 },
    ],
    rows: [
      { item: 'Report', value: title },
      { item: 'GSTIN', value: report.gstin },
      { item: 'From', value: report.from },
      { item: 'To', value: report.to },
      ...extra.map(([item, value]) => ({ item, value })),
      { item: 'Prepared at', value: new Date().toISOString() },
      { item: 'Issues to review', value: String(problems) },
    ],
  };
}

async function finishTableReport(
  tx: Parameters<typeof recordAudit>[0],
  args: {
    title: string;
    label: string;
    format: 'json' | 'xlsx' | 'ca';
    report: TableReport;
    extra?: readonly [string, string][];
  },
): Promise<TableReportOutput> {
  const { report, format } = args;
  const rows = report.sheets.reduce((n, s) => n + s.rows.length, 0);
  await recordAudit(tx, {
    action: 'gst_report.generated',
    entityType: 'gst_report',
    metadata: { report: args.label, gstin: report.gstin, from: report.from, to: report.to, rows, format },
  });
  log.info(
    { report: args.label, gstin: report.gstin, from: report.from, to: report.to, rows, format },
    'GST table report generated',
  );
  if (format === 'json') return { kind: 'json', report };

  const used = new Set<string>(['Issues', 'Summary']);
  const specs: SheetSpec[] = [];
  if (format === 'ca') specs.push(coverSheet(args.title, report, args.extra ?? []));
  for (const s of report.sheets) specs.push(toSheetSpec(s, used));
  specs.push(issueSheet(report.issues));
  const buffer = await buildWorkbook(specs);
  const objectKey = await upload('export', SPREADSHEET_CONTENT_TYPE, buffer);
  return {
    kind: 'file',
    objectKey,
    filename: `${args.label}-${report.gstin}-${report.from}_${report.to}${format === 'ca' ? '-CA-package' : ''}.xlsx`,
    contentType: SPREADSHEET_CONTENT_TYPE,
    report,
  };
}

export function hsnSalesReport(query: HsnSalesQuery): Promise<TableReportOutput> {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const gstin = await resolveGstin(tx, query.gstin);
    const docs = await returnsRepository.outwardDocuments(tx, gstin, query.from, query.to);
    const descriptions = await returnsRepository.hsnDescriptions(
      tx,
      docs.flatMap((d) => d.lines.flatMap((l) => (l.hsn ? [l.hsn] : []))),
    );
    const built = buildHsnSales(docs, descriptions);
    return finishTableReport(tx, {
      title: 'Sales Summary by HSN',
      label: 'HSN-Sales',
      format: query.format,
      report: {
        form: 'hsn_sales',
        gstin,
        from: query.from,
        to: query.to,
        sheets: built.sheets,
        summary: [],
        issues: built.issues,
      },
    });
  });
}

export function sacReport(query: SacQuery): Promise<TableReportOutput> {
  return withTransaction(async (tx) => {
    await assertFeature(tx, 'gst_workings');
    const gstin = await resolveGstin(tx, query.gstin);
    const wantSales = query.transaction === 'all' || query.transaction.startsWith('sale');
    const wantPurchases = query.transaction === 'all' || query.transaction.startsWith('purchase');
    const outward = wantSales
      ? await returnsRepository.outwardDocuments(tx, gstin, query.from, query.to)
      : [];
    const inward = wantPurchases
      ? await returnsRepository.inwardDocuments(tx, gstin, query.from, query.to)
      : [];
    const masterServices = await returnsRepository.masterServiceCodes(tx);
    const codes = [
      ...outward.flatMap((d) => d.lines.flatMap((l) => (l.hsn ? [l.hsn] : []))),
      ...inward.flatMap((d) => d.lines.flatMap((l) => (l.hsn ? [l.hsn] : []))),
    ];
    const descriptions = await returnsRepository.hsnDescriptions(tx, codes);
    const built = buildSacReport({
      outward,
      inward,
      filter: query.transaction,
      masterServices,
      descriptions,
    });
    const issues = [...built.issues];
    if (masterServices.size === 0) {
      issues.push({
        severity: 'info',
        code: 'hsn_master_not_loaded',
        message:
          'The HSN/SAC master is not loaded, so services are recognised by the chapter 99 prefix alone and descriptions are blank.',
      });
    }
    return finishTableReport(tx, {
      title: 'SAC Report',
      label: 'SAC',
      format: query.format,
      extra: [['Transaction', query.transaction]],
      report: {
        form: 'sac',
        gstin,
        from: query.from,
        to: query.to,
        sheets: [built.sheet],
        summary: [],
        issues,
      },
    });
  });
}
