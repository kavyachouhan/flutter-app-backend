/**
 * The spreadsheet column engine every import kind shares.
 *
 * A kind (items, customers, suppliers) declares its columns: what we call the
 * field, what other software calls it, and what type a cell must be. This file
 * turns that declaration into the two operations an import needs:
 *
 *   matchHeaders  a file's header row → which column holds which field
 *   parseRow      one row of cells → stored values, or a message per bad cell
 *
 * Pure and dependency-free (bar the money and state tables), because every
 * rule in here is a conversion a shopkeeper's data passes through: rupees to
 * paise, "GST@5%" to 5, "26/08/2016" to a date. Those deserve tests, not a
 * debugging session.
 *
 * Synonyms are why a file exported from Vyapar, myBillBook or a hand-made
 * sheet matches without the shop renaming anything. They are compared after
 * {@link normaliseHeader}, so "Contact No." and "contact_no" are one form.
 */
import { QUANTITY_SCALE, rupeesStringToPaise } from '../../lib/money.js';
import { STATE_NAMES } from '../print/states.js';

export type ColumnType =
  | 'text'
  | 'money'
  | 'signedMoney'
  | 'quantity'
  | 'percent'
  | 'decimal'
  | 'boolean'
  | 'itemType'
  | 'discountType'
  | 'phone'
  | 'email'
  | 'gstin'
  | 'state'
  | 'date'
  | 'days'
  | 'hsn';

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The 15th character of a GSTIN, computed from the first 14 (GSTN's mod-36
 * check digit). The database refuses a party whose GSTIN fails this
 * (`app.gstin_valid`), so the import must catch it on the review screen —
 * otherwise the row looks fine there and only fails on Save.
 */
export function gstinCheckDigit(gstin: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_ALPHABET.indexOf(gstin.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET.charAt((36 - (total % 36)) % 36);
}

/** The state codes `app.gstin_valid` accepts: 01–38, 97 (other territory) and 99 (centre). */
function gstinStateValid(gstin: string): boolean {
  const state = Number(gstin.slice(0, 2));
  return (state >= 1 && state <= 38) || state === 97 || state === 99;
}

export interface ColumnDefinition {
  readonly key: string;
  /** What the exporter writes, and the name shown on the column-matching screen. */
  readonly header: string;
  readonly type: ColumnType;
  readonly required: boolean;
  /** Normalised forms that also match this column. `header` is added automatically. */
  readonly synonyms: readonly string[];
  /** Quantity only: may be below zero, as an exported stock figure can be. */
  readonly signed?: boolean;
  /**
   * Applied when a record is created, never to one that already exists — an
   * opening balance or opening stock re-applied on every re-import would
   * quietly double it.
   */
  readonly createOnly?: boolean;
  /** Read to interpret another column and never stored itself (e.g. discount type). */
  readonly transient?: boolean;
}

export type CellValue = string | number | boolean | null | undefined;
export type ParsedValue = string | number | boolean | null;

export interface ParsedRow {
  readonly values: Record<string, ParsedValue>;
  /** Field key to a message, in the shopkeeper's terms. */
  readonly errors: Record<string, string>;
  /** Things worth knowing that do not stop the row, e.g. a converted discount. */
  readonly notes: string[];
}

export interface HeaderMatch {
  /** Field key to the zero-based column index it was found at. */
  readonly map: Record<string, number>;
  /** Headers in the file that matched nothing; ignored, but worth showing. */
  readonly unmatched: readonly string[];
  /** Required fields with no column. The file cannot be imported without these. */
  readonly missingRequired: readonly string[];
}

export interface ColumnSet {
  readonly columns: readonly ColumnDefinition[];
  readonly byKey: ReadonlyMap<string, ColumnDefinition>;
  matchHeaders(headers: readonly string[]): HeaderMatch;
  /** Required fields a column map does not cover. */
  missingRequired(map: Record<string, number>): string[];
  parseRow(cells: readonly CellValue[], map: Record<string, number>): ParsedRow;
}

/** Lowercase, strip everything that is not a letter or digit. "GST %" -> "gst". */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function defineColumns(columns: readonly ColumnDefinition[]): ColumnSet {
  const index = new Map<string, string>();
  for (const column of columns) {
    for (const form of [normaliseHeader(column.header), ...column.synonyms]) {
      // A synonym claimed by two columns would make matching depend on
      // declaration order, which is not something anyone should have to know.
      if (index.has(form) && index.get(form) !== column.key) {
        throw new Error(`Ambiguous import column synonym "${form}".`);
      }
      index.set(form, column.key);
    }
  }
  const byKey = new Map(columns.map((c) => [c.key, c]));

  const missingRequired = (map: Record<string, number>): string[] =>
    columns.filter((c) => c.required && map[c.key] === undefined).map((c) => c.key);

  return {
    columns,
    byKey,
    missingRequired,

    /**
     * A duplicate column wins on first occurrence rather than last: a file
     * with "Rate" early and "Price" late almost always means the first one,
     * and silently preferring the rightmost is the harder behaviour to explain.
     */
    matchHeaders(headers) {
      const map: Record<string, number> = {};
      const unmatched: string[] = [];
      headers.forEach((header, i) => {
        const normalised = normaliseHeader(header);
        if (normalised === '') return;
        const key = index.get(normalised);
        if (key === undefined) {
          unmatched.push(header);
          return;
        }
        if (map[key] === undefined) map[key] = i;
      });
      return { map, unmatched, missingRequired: missingRequired(map) };
    },

    /**
     * Collects every problem rather than stopping at the first: a review
     * screen that reveals one bad cell at a time is worse than none.
     */
    parseRow(cells, map) {
      const values: Record<string, ParsedValue> = {};
      const errors: Record<string, string> = {};
      for (const column of columns) {
        const at = map[column.key];
        if (at === undefined) continue;
        const raw = cells[at];
        const text = raw === null || raw === undefined ? '' : String(raw).trim();
        if (text === '' || isPlaceholder(column, text)) {
          if (column.required) errors[column.key] = `${column.header} is required`;
          else values[column.key] = null;
          continue;
        }
        const result = parseCell(column, text);
        if (typeof result === 'string') errors[column.key] = result;
        else values[column.key] = result.value;
      }
      return { values, errors, notes: [] };
    },
  };
}

/** "-", "NA", "None" in an optional numeric or tax cell mean "nothing here". */
function isPlaceholder(column: ColumnDefinition, text: string): boolean {
  if (column.type === 'text' || column.required) return false;
  return /^(-|—|na|n\/a|none|nil)$/i.test(text);
}

const TRUTHY = new Set(['true', 'yes', 'y', '1']);
const FALSY = new Set(['false', 'no', 'n', '0']);

/** An Excel number cell read as text: "1234567890.0" is the number 1234567890. */
const stripExcelZeroFraction = (text: string): string => text.replace(/^(\d+)\.0+$/, '$1');

const STATE_BY_NAME: ReadonlyMap<string, string> = (() => {
  const byName = new Map<string, string>();
  for (const [code, name] of Object.entries(STATE_NAMES)) {
    const key = normaliseHeader(name.replace(/&/g, 'and'));
    // 28 and 37 are both Andhra Pradesh; a name means the current code.
    if (!byName.has(key) || code === '37') byName.set(key, code);
  }
  return byName;
})();

/** Returns the parsed value, or a message explaining the cell. */
export function parseCell(
  column: ColumnDefinition,
  text: string,
): { value: string | number | boolean } | string {
  const header = column.header;
  switch (column.type) {
    case 'text':
      // A formula is an instruction to a spreadsheet, not data. Stored as a
      // name it would sit in the catalogue and be handed to Excel again on
      // the next export.
      if (text.startsWith('=')) {
        return `${header} looks like a spreadsheet formula; type the value instead`;
      }
      return { value: text };

    case 'money':
    case 'signedMoney': {
      // "(500)" is how accounts write a negative.
      const negative = /^\(.*\)$/.test(text);
      const body = negative ? text.slice(1, -1) : text;
      try {
        const paise = rupeesStringToPaise(body, header) * (negative ? -1 : 1);
        if (column.type === 'money' && paise < 0) return `${header} cannot be negative`;
        return { value: paise };
      } catch {
        return `${header} must be an amount like 149.50`;
      }
    }

    case 'quantity': {
      // Quantities are decimal in the file (2.5 kg) and thousandths stored.
      const cleaned = text.replace(/,/g, '');
      const pattern = column.signed ? /^-?\d+(\.\d{1,3})?$/ : /^\d+(\.\d{1,3})?$/;
      if (!pattern.test(cleaned)) {
        return column.signed
          ? `${header} must be a quantity like 12, 2.5 or -3`
          : `${header} must be a quantity like 12 or 2.5`;
      }
      const negative = cleaned.startsWith('-');
      const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.');
      const scaled = Number(whole) * QUANTITY_SCALE + Number(fraction.padEnd(3, '0'));
      if (!Number.isSafeInteger(scaled)) return `${header} is too large`;
      return { value: negative ? -scaled : scaled };
    }

    case 'percent': {
      // "18", "18%", and what other apps export: "GST@5%", "IGST@0%", "GST 18%".
      const match = /^(?:[a-z]+\s*@?\s*)?(\d+(?:\.\d+)?)\s*%?$/i.exec(text.replace(/\s+/g, ' '));
      const value = match ? Number(match[1]) : Number.NaN;
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return `${header} must be a percentage between 0 and 100`;
      }
      return { value };
    }

    case 'decimal': {
      const value = Number(text.replace(/[₹,%\s]/g, ''));
      if (!Number.isFinite(value) || value < 0) return `${header} must be a number like 5 or 2.5`;
      return { value: Math.round(value * 100) / 100 };
    }

    case 'boolean': {
      const lower = text.toLowerCase();
      if (TRUTHY.has(lower)) return { value: true };
      if (FALSY.has(lower)) return { value: false };
      return `${header} must be Yes or No`;
    }

    case 'itemType': {
      const lower = text.toLowerCase();
      if (lower.startsWith('g') || lower.startsWith('p')) return { value: 'goods' };
      if (lower.startsWith('s')) return { value: 'service' };
      return `${header} must be Goods or Service`;
    }

    case 'discountType': {
      const lower = text.toLowerCase();
      if (lower.includes('%') || lower.includes('percent')) return { value: 'percent' };
      if (/amount|amt|flat|value|rs|₹|rupee/.test(lower)) return { value: 'amount' };
      return `${header} must be "Discount %" or "Discount Amount"`;
    }

    case 'phone': {
      // Final normalisation (country code) is the caller's: it depends on
      // the deployment's phone rules. Here it only has to look like one.
      const cleaned = stripExcelZeroFraction(text);
      if (!/^[\d\s()+.-]+$/.test(cleaned) || cleaned.replace(/\D/g, '').length < 8) {
        return `${header} must be a phone number`;
      }
      return { value: cleaned };
    }

    case 'email': {
      const lower = text.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return `${header} must be an email address`;
      return { value: lower };
    }

    case 'gstin': {
      const upper = text.toUpperCase().replace(/\s/g, '');
      if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(upper)) {
        return `${header} must be a 15-character GSTIN like 29ABCDE1234F1ZW`;
      }
      if (!gstinStateValid(upper)) {
        return `${header} ${upper} starts with ${upper.slice(0, 2)}, which is not a GST state code`;
      }
      if (gstinCheckDigit(upper) !== upper[14]) {
        return `${header} ${upper} has a typo: its last character does not match the rest`;
      }
      return { value: upper };
    }

    case 'state': {
      // "29", "29-Karnataka", "Karnataka".
      const code = /^(\d{1,2})\b/.exec(text)?.[1];
      if (code !== undefined) {
        const padded = code.padStart(2, '0');
        if (STATE_NAMES[padded]) return { value: padded };
      }
      const byName = STATE_BY_NAME.get(
        normaliseHeader(text.replace(/^\d+\s*-\s*/, '').replace(/&/g, 'and')),
      );
      if (byName) return { value: byName };
      return `${header} must be an Indian state name or its 2-digit GST code`;
    }

    case 'date':
      return parseDate(header, text);

    case 'hsn': {
      // 4, 6 or 8 digits. A spreadsheet that stored the code as a number has
      // dropped its leading zero ("0902" became 902), which leaves it one digit
      // short of an even length: put the zero back.
      let digits = stripExcelZeroFraction(text).replace(/\s/g, '');
      if (!/^\d+$/.test(digits)) return `${header} must be 4 to 8 digits, like 0902 or 30049099`;
      if (digits.length % 2 === 1 && digits.length < 8) digits = `0${digits}`;
      if (digits.length < 4 || digits.length > 8) {
        return `${header} must be 4 to 8 digits, like 0902 or 30049099`;
      }
      return { value: digits };
    }

    case 'days': {
      const value = Number(stripExcelZeroFraction(text));
      if (!Number.isInteger(value) || value < 0 || value > 365) {
        return `${header} must be a number of days from 0 to 365`;
      }
      return { value };
    }
  }
}

/**
 * Dates as Indian software writes them: day first. "26/08/2016", "26-08-2016",
 * "26.08.2016", or ISO "2016-08-26" (what a real Excel date cell becomes).
 * Never a future date: an opening balance is what was owed before today.
 */
function parseDate(header: string, text: string): { value: string } | string {
  const bad = `${header} must be a date like 26/08/2016`;
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dayFirst) {
    [day, month, year] = [Number(dayFirst[1]), Number(dayFirst[2]), Number(dayFirst[3])];
  } else {
    return bad;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    year < 1900
  ) {
    return bad;
  }
  const value = date.toISOString().slice(0, 10);
  if (value > new Date().toISOString().slice(0, 10)) return `${header} cannot be in the future`;
  return { value };
}
