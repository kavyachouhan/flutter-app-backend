/**
 * Reading an uploaded spreadsheet into plain rows.
 *
 * **On not using ExcelJS's streaming reader.** It would be the better choice
 * on paper — xlsx is a zip, so a few megabytes of upload can expand into a
 * much larger worksheet model on the heap of a shared API process. It is not
 * usable: `WorkbookReader` resolves a sheet's name through `this.model.sheets`
 * (workbook-reader.js:303) but only guards on `sharedStrings && workbookRels`
 * (:108), so when the zip yields a worksheet entry before `xl/workbook.xml`
 * it throws on an undefined model. That ordering is exactly what ExcelJS's
 * own writer produces, so our round-trip test hit it immediately. Its
 * fallback path also spools worksheets to temp files on disk, which is a
 * surprise nobody asked for in a request handler.
 *
 * So the whole workbook is loaded, and the memory ceiling is held by the
 * upload cap instead (`import` is limited to 10 MB in src/lib/storage.ts; a
 * 50,000-row price list is a few megabytes). If that ceiling ever becomes
 * the binding constraint, the answer is a worker with its own memory budget,
 * not a different parser.
 *
 * Cells arrive as whatever ExcelJS decided they were — numbers, dates, rich
 * text, formula results — and leave here as strings. Interpretation is the
 * column model's job (src/domain/import/item-columns.ts), which is where the
 * money and quantity rules live and can be tested.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { ErrorCode, UnprocessableError, ValidationError } from '../../lib/errors.js';

export interface SheetData {
  readonly headers: string[];
  readonly rows: { rowNo: number; cells: string[] }[];
}

/** ExcelJS cell values are a union of several object shapes; flatten to text. */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const object = value as Record<string, unknown>;
  // A formula cell: the cached result is what the shopkeeper sees.
  if ('result' in object) return cellToText(object['result']);
  if ('text' in object) return cellToText(object['text']);
  if ('hyperlink' in object) return cellToText(object['text'] ?? object['hyperlink']);
  // Rich text: concatenate the runs.
  if (Array.isArray(object['richText'])) {
    return (object['richText'] as { text?: string }[])
      .map((r) => r.text ?? '')
      .join('')
      .trim();
  }
  if ('error' in object) return '';
  return '';
}

/**
 * `row.values` is 1-based with a hole at index 0, which is a long-standing
 * ExcelJS quirk and the source of every off-by-one in code that uses it.
 */
function rowToCells(values: unknown, width: number): string[] {
  const array = Array.isArray(values) ? values : [];
  const cells: string[] = [];
  for (let column = 1; column <= width; column++) {
    cells.push(cellToText(array[column]));
  }
  return cells;
}

const isBlank = (cells: readonly string[]): boolean => cells.every((c) => c === '');

export async function readSpreadsheet(
  buffer: Buffer,
  objectKey: string,
  maxRows: number,
): Promise<SheetData> {
  const csv = objectKey.toLowerCase().endsWith('.csv');
  try {
    return csv ? await readCsv(buffer, maxRows) : await readXlsx(buffer, maxRows);
  } catch (error) {
    // A row-cap breach is a decision, not a parse failure; let it through.
    if (error instanceof ValidationError || error instanceof UnprocessableError) throw error;
    throw new UnprocessableError(
      'That file could not be read as a spreadsheet. Save it as .xlsx or .csv and try again.',
      ErrorCode.IMPORT_UNREADABLE,
      { cause: error },
    );
  }
}

function assertWithinCap(count: number, maxRows: number): void {
  if (count > maxRows) {
    throw new UnprocessableError(
      `That file has more than ${maxRows} rows. Split it and import the parts separately.`,
      ErrorCode.IMPORT_TOO_LARGE,
      { details: { maxRows } },
    );
  }
}

async function readXlsx(buffer: Buffer, maxRows: number): Promise<SheetData> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS's own types declare `Buffer extends ArrayBuffer`, shadowing
  // Node's, so it is handed a plain ArrayBuffer rather than papered over
  // with a cast. Copied into a fresh one because `buffer.buffer` is an
  // ArrayBufferLike that may be shared and may be a view into a larger pool.
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  await workbook.xlsx.load(bytes.buffer);

  // First sheet only. A workbook with several is almost always one list plus
  // notes, and guessing which is the list is worse than saying so.
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new UnprocessableError('That file has no sheets.', ErrorCode.IMPORT_UNREADABLE);
  }
  return walk(worksheet, maxRows);
}

async function readCsv(buffer: Buffer, maxRows: number): Promise<SheetData> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = await workbook.csv.read(Readable.from(buffer));
  return walk(worksheet, maxRows);
}

/** One walker for both formats: by this point a CSV is a worksheet too. */
function walk(worksheet: ExcelJS.Worksheet, maxRows: number): SheetData {
  let headers: string[] | null = null;
  let width = 0;
  const rows: { rowNo: number; cells: string[] }[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];

    if (headers === null) {
      // The header row sets the width; a trailing cell beyond it in a later
      // row is a stray note, not a column.
      width = Math.max(0, (Array.isArray(values) ? values.length : 1) - 1);
      const candidate = rowToCells(values, width);
      if (!isBlank(candidate)) headers = candidate;
      return;
    }

    const cells = rowToCells(values, width);
    if (isBlank(cells)) return;
    assertWithinCap(rows.length + 1, maxRows);
    // The spreadsheet's own row number, so an error message points at the
    // line the shopkeeper is looking at.
    rows.push({ rowNo: row.number, cells });
  });

  if (headers === null) {
    throw new UnprocessableError('That file has no header row.', ErrorCode.IMPORT_COLUMN_UNMAPPED);
  }
  return { headers, rows };
}
