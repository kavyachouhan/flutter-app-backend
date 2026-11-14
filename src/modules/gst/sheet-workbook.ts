/**
 * Turns return/report `Sheet`s into workbook sheets.
 *
 * One converter for the prepared-return exports and the report exports, so a figure in the Excel
 * file is the figure on screen whichever of them produced it.
 */
import type {
  Sheet,
  SheetColumn as ReturnColumn,
  WorkingIssue,
} from '../../domain/gst/returns/sheets.js';
import {
  paiseToNumber,
  quantityToNumber,
  type ColumnFormat,
  type SheetColumn,
  type SheetSpec,
} from '../exports/workbook.js';

type Row = Record<string, unknown>;

const FORMAT: Readonly<Record<ReturnColumn['kind'], ColumnFormat>> = {
  text: 'text',
  money: 'money',
  number: 'number',
  percent: 'number',
  date: 'date',
  quantity: 'quantity',
};

const convert = (kind: ReturnColumn['kind'], value: unknown): unknown => {
  if (typeof value !== 'number') return value ?? null;
  if (kind === 'money') return paiseToNumber(value);
  if (kind === 'quantity') return quantityToNumber(value);
  return value;
};

/** Excel sheet names: at most 31 characters and none of `\ / ? * [ ] :`. */
export const sheetName = (title: string, used: Set<string>): string => {
  const base =
    title
      .replace(/[\\/?*[\]:]/g, ' ')
      .slice(0, 31)
      .trim() || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name);
  return name;
};

/** A return sheet as a workbook sheet, with a totals row when any column totals. */
export function toSheetSpec(sheet: Sheet, used: Set<string>, name?: string): SheetSpec {
  const columns: SheetColumn[] = sheet.columns.map((c) => ({
    header: c.label,
    key: c.key,
    format: FORMAT[c.kind],
    width: c.kind === 'text' ? 22 : 16,
  }));
  const rows: Row[] = sheet.rows.map((row) => {
    const out: Row = {};
    for (const c of sheet.columns) out[c.key] = convert(c.kind, row[c.key]);
    return out;
  });
  if (sheet.columns.some((c) => c.total) && sheet.rows.length > 0) {
    const first = sheet.columns[0];
    const totals: Row = {};
    for (const c of sheet.columns) {
      totals[c.key] = c.total ? convert(c.kind, sheet.totals[c.key] ?? 0) : null;
    }
    if (first && !first.total) totals[first.key] = 'Total';
    rows.push(totals);
  }
  return { name: sheetName(name ?? sheet.id, used), columns, rows };
}

export const issueSheet = (issues: readonly WorkingIssue[]): SheetSpec => ({
  name: 'Issues',
  columns: [
    { header: 'Severity', key: 'severity', format: 'text', width: 10 },
    { header: 'Code', key: 'code', format: 'text', width: 30 },
    { header: 'Count', key: 'count', format: 'number', width: 8 },
    { header: 'Reference', key: 'ref', format: 'text', width: 20 },
    { header: 'What to check', key: 'message', format: 'text', width: 90 },
  ],
  rows: issues.map((i) => ({ ...i, count: i.count ?? null, ref: i.ref ?? '' })),
});
