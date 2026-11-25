/**
 * Checks on an uploaded spreadsheet's *contents*, before any parser sees it.
 *
 * The upload path already proved the file is the type it claims to be (its
 * first bytes, its size, that it is not a program — src/lib/storage.ts). That
 * is not enough for a spreadsheet, because the dangerous part of one is
 * inside it:
 *
 * - **Macros.** A workbook can carry VBA (`xl/vbaProject.bin`, the
 *   `_VBA_PROJECT_CUR` storage of an .xls) or old Excel 4.0 macro sheets. We
 *   never run them, but a file holding them is not a price list, and storing
 *   or passing it along is how one reaches a shop's PC.
 * - **Embedded objects.** OLE objects and ActiveX controls (`xl/embeddings/`,
 *   `xl/activeX/`) can carry an arbitrary payload.
 * - **Zip bombs.** An .xlsx is a zip. A 10 MB upload can declare — or simply
 *   contain — gigabytes once inflated, and the spreadsheet library would try
 *   to hold all of it in the API process's memory. Every entry is therefore
 *   inflated here first under a hard output cap, so a bomb fails here, cheaply,
 *   rather than inside the parser.
 *
 * This is not an antivirus scan. It refuses the things a spreadsheet import
 * has no reason to accept; it does not look for known malware signatures.
 */
import { inflateRawSync } from 'node:zlib';
import { ErrorCode, UnprocessableError } from '../../lib/errors.js';

/** Inflated bytes allowed across a whole workbook. A 50,000-row sheet is a few tens of MB. */
export const MAX_INFLATED_BYTES = 150 * 1024 * 1024;
/** Zip entries allowed. A real workbook has a few dozen. */
export const MAX_ZIP_ENTRIES = 2000;

const unsafe = (message: string) => new UnprocessableError(message, ErrorCode.IMPORT_UNSAFE);

const MACRO_MESSAGE =
  'That file contains macros. Save it in Excel as a plain workbook (.xlsx) without macros, then import it.';
const EMBEDDED_MESSAGE =
  'That file contains embedded objects or controls. Copy just the table into a new workbook and import that.';

export interface SafetyLimits {
  maxInflatedBytes: number;
  maxZipEntries: number;
}

const DEFAULT_LIMITS: SafetyLimits = {
  maxInflatedBytes: MAX_INFLATED_BYTES,
  maxZipEntries: MAX_ZIP_ENTRIES,
};

/** Throws when the spreadsheet carries something an import has no reason to accept. */
export function assertSpreadsheetSafe(
  buffer: Buffer,
  extension: string,
  limits: SafetyLimits = DEFAULT_LIMITS,
): void {
  if (extension === 'xlsx') inspectXlsx(buffer, limits);
  else if (extension === 'xls') inspectXls(buffer);
  // A CSV is plain text: the upload check already refused markup and
  // binaries, and a formula-looking cell is refused per cell when parsed.
}

// ---------------------------------------------------------------------------
// .xlsx — a zip archive
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
}

function inspectXlsx(buffer: Buffer, limits: SafetyLimits): void {
  const entries = readCentralDirectory(buffer, limits);

  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (name.endsWith('vbaproject.bin') || name.startsWith('xl/macrosheets/')) {
      throw unsafe(MACRO_MESSAGE);
    }
    if (name.startsWith('xl/embeddings/') || name.startsWith('xl/activex/')) {
      throw unsafe(EMBEDDED_MESSAGE);
    }
  }

  // Declared sizes first: cheap, and enough for an honest bomb.
  const declared = entries.reduce((sum, e) => sum + e.declaredSize, 0);
  if (declared > limits.maxInflatedBytes) throw unsafe(bombMessage());

  // Then the real sizes, because a crafted archive can lie about them.
  let budget = limits.maxInflatedBytes;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // a directory
    budget -= inflatedSize(buffer, entry, budget);
  }
}

const bombMessage = () =>
  'That file expands to far more data than a spreadsheet of its size should. It cannot be imported.';

/** Reads the archive's table of contents from the end-of-central-directory record. */
function readCentralDirectory(buffer: Buffer, limits: SafetyLimits): ZipEntry[] {
  const unreadable = () =>
    new UnprocessableError('That file is not a valid Excel workbook.', ErrorCode.IMPORT_UNREADABLE);

  // The EOCD record is 22 bytes plus a comment of up to 65,535.
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable();

  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  // 0xFFFF / 0xFFFFFFFF mean "see the ZIP64 record". No spreadsheet within
  // the upload limit needs ZIP64, and parsing it only widens what to trust.
  if (count === 0xffff || directoryOffset === 0xffffffff) throw unsafe(bombMessage());
  if (count > limits.maxZipEntries) throw unsafe(bombMessage());

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw unreadable();
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const declaredSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localHeaderOffset = buffer.readUInt32LE(at + 42);
    if (compressedSize === 0xffffffff || declaredSize === 0xffffffff) throw unsafe(bombMessage());
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.push({ name, method, compressedSize, declaredSize, localHeaderOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The entry's real inflated size, refusing to produce more than [budget] bytes. */
function inflatedSize(buffer: Buffer, entry: ZipEntry, budget: number): number {
  const at = entry.localHeaderOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) {
    throw new UnprocessableError(
      'That file is not a valid Excel workbook.',
      ErrorCode.IMPORT_UNREADABLE,
    );
  }
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) {
    throw new UnprocessableError(
      'That file is not a valid Excel workbook.',
      ErrorCode.IMPORT_UNREADABLE,
    );
  }

  if (entry.method === 0) {
    if (entry.compressedSize > budget) throw unsafe(bombMessage());
    return entry.compressedSize;
  }
  if (entry.method !== 8) {
    throw new UnprocessableError(
      'That workbook uses a compression Excel does not. Re-save it in Excel and try again.',
      ErrorCode.IMPORT_UNREADABLE,
    );
  }
  try {
    return inflateRawSync(buffer.subarray(start, end), { maxOutputLength: Math.max(1, budget) })
      .byteLength;
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw unsafe(bombMessage());
    }
    throw new UnprocessableError(
      'That file is not a valid Excel workbook.',
      ErrorCode.IMPORT_UNREADABLE,
      {
        cause: error,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// .xls — an OLE compound file
// ---------------------------------------------------------------------------

/**
 * Storage names in a compound file's directory are UTF-16LE. VBA lives under
 * `_VBA_PROJECT_CUR`; embedded objects under `ObjectPool`.
 *
 * A byte search over the directory is enough here: the names are fixed by
 * the format, and a false positive only means a shop re-saves the file.
 * Excel 4.0 macro *sheets* are not storages, so the reader checks those
 * separately once the workbook is parsed.
 */
function inspectXls(buffer: Buffer): void {
  if (buffer.includes(Buffer.from('_VBA_PROJECT', 'utf16le'))) throw unsafe(MACRO_MESSAGE);
  // `ObjectPool` holds every embedded OLE object; `\u0001Ole10Native` is the
  // "package" kind that wraps an arbitrary file.
  if (
    buffer.includes(Buffer.from('ObjectPool', 'utf16le')) ||
    buffer.includes(Buffer.from('\u0001Ole10Native', 'utf16le'))
  ) {
    throw unsafe(EMBEDDED_MESSAGE);
  }
}

export const XLS_MACRO_SHEET_MESSAGE = MACRO_MESSAGE;
