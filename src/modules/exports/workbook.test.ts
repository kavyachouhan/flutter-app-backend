/**
 * The round-trip, for real: build a workbook, write the bytes, read them
 * back through the importer's own reader and parser, and check the values
 * survived.
 *
 * `round-trip.test.ts` proves the two column lists agree. This proves the
 * file format does too — that a price written as a number comes back as the
 * same paise, and that the reader finds the header row where the writer put
 * it. Those are the parts that break silently.
 */
import { describe, expect, it } from 'vitest';
import { matchHeaders, parseItemRow } from '../../domain/import/item-columns.js';
import { readSpreadsheet } from '../imports/spreadsheet.js';
import { itemExportHeaders } from './exports.service.js';
import { buildWorkbook, paiseToNumber, quantityToNumber } from './workbook.js';

const COLUMNS = [
  { header: 'Name', key: 'name', format: 'text' as const },
  { header: 'Code', key: 'code', format: 'text' as const },
  { header: 'GST %', key: 'taxRatePercent', format: 'number' as const },
  { header: 'Sale price', key: 'salePrice', format: 'money' as const },
  { header: 'Opening stock', key: 'openingStock', format: 'quantity' as const },
];

describe('buildWorkbook', () => {
  it('writes a file the importer can read back', async () => {
    const buffer = await buildWorkbook([
      {
        name: 'Items',
        columns: COLUMNS,
        rows: [
          {
            name: 'Parle-G 100g',
            code: 'PG100',
            taxRatePercent: 18,
            salePrice: paiseToNumber(1050),
            openingStock: quantityToNumber(2500),
          },
          {
            name: 'Tata Salt 1kg',
            code: 'TS1',
            taxRatePercent: 5,
            salePrice: paiseToNumber(2899),
            openingStock: quantityToNumber(12000),
          },
        ],
      },
    ]);

    const sheet = await readSpreadsheet(buffer, 'export.xlsx', 1000);
    expect(sheet.headers).toEqual(COLUMNS.map((c) => c.header));
    expect(sheet.rows).toHaveLength(2);

    const { map } = matchHeaders(sheet.headers);
    const first = parseItemRow(sheet.rows[0]?.cells ?? [], map);

    expect(first.errors).toEqual({});
    expect(first.values['name']).toBe('Parle-G 100g');
    // The money scale survived the trip through the file, which is the whole
    // point: 1050 paise out, 1050 paise back.
    expect(first.values['salePrice']).toBe(1050);
    expect(first.values['taxRatePercent']).toBe(18);
    expect(first.values['openingStock']).toBe(2500);

    const second = parseItemRow(sheet.rows[1]?.cells ?? [], map);
    expect(second.values['salePrice']).toBe(2899);
    expect(second.values['openingStock']).toBe(12000);
  });

  it('round-trips the real items export header set', async () => {
    const headers = itemExportHeaders();
    const buffer = await buildWorkbook([
      {
        name: 'Items',
        columns: headers.map((header) => ({ header, key: header, format: 'text' as const })),
        rows: [],
      },
    ]);
    // An empty export still has to be re-importable: a shop that exports an
    // empty catalogue, fills it in and imports it back is a real onboarding
    // path, and that file's header row is this one.
    const sheet = await readSpreadsheet(buffer, 'export.xlsx', 1000);
    expect(matchHeaders(sheet.headers).missingRequired).toEqual([]);
    expect(matchHeaders(sheet.headers).unmatched).toEqual([]);
  });

  it('rejects a file with more rows than allowed, before storing any of them', async () => {
    const buffer = await buildWorkbook([
      {
        name: 'Items',
        columns: COLUMNS,
        rows: Array.from({ length: 5 }, (_, i) => ({ name: `Item ${i}` })),
      },
    ]);
    await expect(readSpreadsheet(buffer, 'export.xlsx', 3)).rejects.toMatchObject({
      code: 'IMPORT_TOO_LARGE',
    });
  });
});
