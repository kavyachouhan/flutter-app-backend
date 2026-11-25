import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { readSpreadsheet } from './spreadsheet.js';

/** An Excel 97–2003 workbook, written the way Vyapar's export is. */
function xls(rows: unknown[][], dateCell?: { r: number; c: number; value: Date }): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (dateCell) {
    const address = XLSX.utils.encode_cell(dateCell);
    sheet[address] = { t: 'd', v: dateCell.value, z: 'dd/mm/yyyy' };
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet0');
  return Buffer.from(
    XLSX.write(book, { type: 'buffer', bookType: 'biff8', cellDates: true }) as Uint8Array,
  );
}

describe('readSpreadsheet: .xls', () => {
  it('reads the header row and every data row, with the spreadsheet row numbers', async () => {
    const sheet = await readSpreadsheet(
      xls([
        ['Item Name', 'Sale Price', 'Tax Rate'],
        ['Tea', 20, 'GST@5%'],
        [],
        ['Rice', 49.5, 'GST@0%'],
      ]),
      't/import/x.xls',
      100,
    );
    expect(sheet.headers).toEqual(['Item Name', 'Sale Price', 'Tax Rate']);
    expect(sheet.rows).toEqual([
      { rowNo: 2, cells: ['Tea', '20', 'GST@5%'] },
      // The blank row 3 is skipped, and row 4 keeps its own number.
      { rowNo: 4, cells: ['Rice', '49.5', 'GST@0%'] },
    ]);
  });

  it('writes a 12-digit phone number out in full, not as 9.19877E+11', async () => {
    const sheet = await readSpreadsheet(
      xls([
        ['Name', 'Contact No.'],
        ['Party 1', 919876543210],
      ]),
      't/import/x.xls',
      100,
    );
    expect(sheet.rows[0]?.cells).toEqual(['Party 1', '919876543210']);
  });

  it('turns a date cell into an ISO date', async () => {
    const sheet = await readSpreadsheet(
      xls(
        [
          ['Name', 'Opening Date'],
          ['Party 1', ''],
        ],
        { r: 1, c: 1, value: new Date(Date.UTC(2016, 7, 26)) },
      ),
      't/import/x.xls',
      100,
    );
    expect(sheet.rows[0]?.cells[1]).toBe('2016-08-26');
  });

  it('refuses more rows than the limit rather than importing part of the file', async () => {
    const rows = [['Name'], ...Array.from({ length: 5 }, (_, i) => [`Item ${i}`])];
    await expect(readSpreadsheet(xls(rows), 't/import/x.xls', 3)).rejects.toMatchObject({
      code: 'IMPORT_TOO_LARGE',
    });
  });

  it('refuses a file that only says it is .xls, before SheetJS can read it as something else', async () => {
    await expect(
      readSpreadsheet(Buffer.from('not a workbook'), 't/import/x.xls', 10),
    ).rejects.toMatchObject({
      code: 'IMPORT_UNSAFE',
    });
    const page = Buffer.from('<html><table><tr><td>Name</td></tr></table></html>');
    await expect(readSpreadsheet(page, 't/import/x.xls', 10)).rejects.toMatchObject({
      code: 'IMPORT_UNSAFE',
    });
  });

  it('refuses a program renamed to a spreadsheet', async () => {
    const program = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
    for (const key of ['t/import/x.xlsx', 't/import/x.xls', 't/import/x.csv']) {
      await expect(readSpreadsheet(program, key, 10)).rejects.toMatchObject({
        code: 'IMPORT_UNSAFE',
      });
    }
  });

  it('refuses a CSV that is really a web page', async () => {
    const page = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');
    await expect(readSpreadsheet(page, 't/import/x.csv', 10)).rejects.toMatchObject({
      code: 'IMPORT_UNSAFE',
    });
  });
});
