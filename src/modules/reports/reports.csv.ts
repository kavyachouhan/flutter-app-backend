/**
 * A report as CSV.
 *
 * The registry's whole reason for carrying `kind` on every column was that one
 * widget could render any report and the export could be generic. This is the
 * export: it reads the same `ReportResult` the JSON endpoint returns and needs
 * to know nothing about which report produced it.
 *
 * Scales are converted here rather than in the reports: a report returns paise
 * and thousandths like everything else in the system, and a person opening a
 * spreadsheet expects rupees and units.
 */
import { PAISE_PER_RUPEE, QUANTITY_SCALE } from '../../lib/money.js';
import type { ReportColumn, ReportResult, ReportRow } from './reports.types.js';

/**
 * Quotes a field for CSV.
 *
 * Also guards against formula injection: a value beginning `=`, `+`, `-` or `@`
 * is executed as a formula when the file is opened in Excel or Sheets, and
 * report rows carry customer and item names a customer chose. Prefixing a tab
 * stops that without changing what the cell reads as.
 */
function field(value: unknown): string {
  if (value === null || value === undefined) return '';
  // A report row is `Record<string, unknown>`, so narrow before stringifying:
  // an object reaching String() would silently become '[object Object]' in a
  // cell rather than saying anything useful.
  let text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
        ? String(value)
        : value instanceof Date
          ? value.toISOString()
          : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `\t${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Paise and thousandths become decimal numbers; everything else passes through. */
function cell(column: ReportColumn, row: ReportRow): string {
  const value = row[column.key];
  if (value === null || value === undefined) return '';

  if (column.kind === 'money' || column.kind === 'quantity') {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return field(value);
    const scale = column.kind === 'money' ? PAISE_PER_RUPEE : QUANTITY_SCALE;
    // Fixed decimals so a column of figures lines up and nothing is shown in
    // exponential notation, which is what a bare division gives for large runs.
    return (numeric / scale).toFixed(column.kind === 'money' ? 2 : 3);
  }
  return field(value);
}

/**
 * The whole file, including the totals row the UI shows under the figures.
 *
 * The totals are the ones the kernel computed from the rows being returned, so
 * a truncated report's footer still adds up to what is above it — the same
 * guarantee the screen gives.
 */
export function reportToCsv(result: ReportResult): string {
  const lines: string[] = [];
  lines.push(result.columns.map((column) => field(column.label)).join(','));

  for (const row of result.rows) {
    lines.push(result.columns.map((column) => cell(column, row)).join(','));
  }

  const totalled = result.columns.filter((column) => column.total);
  if (totalled.length > 0) {
    lines.push(
      result.columns
        .map((column, index) => {
          if (index === 0) return field('Total');
          if (!column.total) return '';
          return cell(column, result.totals);
        })
        .join(','),
    );
  }

  // CRLF: Excel on Windows is the overwhelmingly common consumer, and it is
  // the line ending RFC 4180 specifies.
  return `${lines.join('\r\n')}\r\n`;
}

/** `sales-summary-2026-04-01-to-2026-04-30.csv` */
export function csvFilename(result: ReportResult): string {
  return `${result.reportId}-${result.params.from}-to-${result.params.to}.csv`;
}
