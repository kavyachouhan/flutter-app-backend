import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, UnprocessableError } from '../../lib/errors.js';
import { assertSpreadsheetSafe } from './file-safety.js';

/**
 * A minimal zip writer: enough to build the archives a real attacker would,
 * including one whose central directory lies about its sizes.
 */
function zip(entries: { name: string; data: Buffer; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const declared = entry.declaredSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const rejectsWith = (fn: () => void, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableError);
    expect((error as UnprocessableError).code).toBe(code);
    return;
  }
  throw new Error('expected the file to be refused');
};

const SMALL = { maxInflatedBytes: 1024 * 1024, maxZipEntries: 50 };

describe('assertSpreadsheetSafe', () => {
  it('accepts a real workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Items').addRows([
      ['Name', 'Rate'],
      ['Tea', 10],
    ]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(() => assertSpreadsheetSafe(buffer, 'xlsx')).not.toThrow();
  });

  it('refuses a workbook carrying VBA macros', () => {
    const file = zip([
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
      { name: 'xl/vbaProject.bin', data: Buffer.from('macro') },
    ]);
    rejectsWith(() => assertSpreadsheetSafe(file, 'xlsx'), ErrorCode.IMPORT_UNSAFE);
  });

  it('refuses old Excel 4.0 macro sheets and embedded objects', () => {
    for (const name of [
      'xl/macrosheets/sheet1.xml',
      'xl/embeddings/oleObject1.bin',
      'xl/activeX/activeX1.xml',
    ]) {
      const file = zip([{ name, data: Buffer.from('x') }]);
      rejectsWith(() => assertSpreadsheetSafe(file, 'xlsx'), ErrorCode.IMPORT_UNSAFE);
    }
  });

  it('refuses a zip bomb that admits its size', () => {
    const file = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(2 * 1024 * 1024) }]);
    // Two megabytes of zeros compress to a couple of kilobytes.
    expect(file.length).toBeLessThan(10_000);
    rejectsWith(() => assertSpreadsheetSafe(file, 'xlsx', SMALL), ErrorCode.IMPORT_UNSAFE);
  });

  it('refuses a zip bomb that lies about its size', () => {
    const file = zip([
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(2 * 1024 * 1024), declaredSize: 10 },
    ]);
    rejectsWith(() => assertSpreadsheetSafe(file, 'xlsx', SMALL), ErrorCode.IMPORT_UNSAFE);
  });

  it('refuses an archive with an absurd number of entries', () => {
    const file = zip(
      Array.from({ length: 60 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })),
    );
    rejectsWith(() => assertSpreadsheetSafe(file, 'xlsx', SMALL), ErrorCode.IMPORT_UNSAFE);
  });

  it('calls a file that is not a zip unreadable, not unsafe', () => {
    rejectsWith(
      () => assertSpreadsheetSafe(Buffer.from('PK not really'), 'xlsx'),
      ErrorCode.IMPORT_UNREADABLE,
    );
  });

  it('refuses an .xls carrying a VBA project or an embedded object', () => {
    const header = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const vba = Buffer.concat([
      header,
      Buffer.alloc(64),
      Buffer.from('_VBA_PROJECT_CUR', 'utf16le'),
    ]);
    const ole = Buffer.concat([header, Buffer.alloc(64), Buffer.from('ObjectPool', 'utf16le')]);
    rejectsWith(() => assertSpreadsheetSafe(vba, 'xls'), ErrorCode.IMPORT_UNSAFE);
    rejectsWith(() => assertSpreadsheetSafe(ole, 'xls'), ErrorCode.IMPORT_UNSAFE);
    expect(() =>
      assertSpreadsheetSafe(Buffer.concat([header, Buffer.alloc(64)]), 'xls'),
    ).not.toThrow();
  });
});
