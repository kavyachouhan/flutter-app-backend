/**
 * Writing a workbook.
 *
 * The property that matters is **round-tripping**: an items export must use
 * exactly the headers the importer recognises as canonical, so a shop can
 * export its catalogue, edit it in Excel, and import it back. That is
 * asserted by a test rather than left to care, because the two lists sit in
 * different files and would otherwise drift apart the first time a column is
 * added.
 *
 * Numbers are written as numbers, not strings. A price column of text is
 * unsortable, unsummable, and shows Excel's green warning triangle on every
 * cell — and the importer reads either, so there is no reason to.
 */
import ExcelJS from 'exceljs';
import { PAISE_PER_RUPEE, QUANTITY_SCALE } from '../../lib/money.js';

export const SPREADSHEET_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Two decimals, with a thousands separator: what a price list looks like. */
const MONEY_FORMAT = '#,##0.00';
const QUANTITY_FORMAT = '#,##0.###';

export type ColumnFormat = 'text' | 'money' | 'quantity' | 'number' | 'date';

export interface SheetColumn {
  readonly header: string;
  readonly key: string;
  readonly format: ColumnFormat;
  readonly width?: number;
}

export interface SheetSpec {
  readonly name: string;
  readonly columns: readonly SheetColumn[];
  readonly rows: readonly Record<string, unknown>[];
}

/** Paise to a rupee number. 1050 -> 10.5, which Excel renders as 10.50. */
export function paiseToNumber(paise: number | null | undefined): number | null {
  if (paise === null || paise === undefined) return null;
  return paise / PAISE_PER_RUPEE;
}

/** Thousandths to a unit number. 2500 -> 2.5. */
export function quantityToNumber(thousandths: number | null | undefined): number | null {
  if (thousandths === null || thousandths === undefined) return null;
  return thousandths / QUANTITY_SCALE;
}

function numberFormatFor(format: ColumnFormat): string | undefined {
  if (format === 'money') return MONEY_FORMAT;
  if (format === 'quantity') return QUANTITY_FORMAT;
  if (format === 'date') return 'yyyy-mm-dd';
  return undefined;
}

export async function buildWorkbook(sheets: readonly SheetSpec[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name);
    sheet.columns = spec.columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width ?? Math.max(12, column.header.length + 2),
    }));

    const header = sheet.getRow(1);
    header.font = { bold: true };
    // Frozen so a shopkeeper scrolling a 2,000-row catalogue keeps the
    // column names in view — the difference between a usable export and one
    // that gets re-sorted into nonsense.
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of spec.rows) {
      const added = sheet.addRow(row);
      spec.columns.forEach((column, index) => {
        const format = numberFormatFor(column.format);
        if (format) added.getCell(index + 1).numFmt = format;
      });
    }

    if (spec.rows.length > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: spec.columns.length },
      };
    }
  }

  // ExcelJS types this as its own Buffer alias; it is a Node Buffer.
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
