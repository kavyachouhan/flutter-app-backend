/**
 * The item spreadsheet contract: which columns exist, what a shop might call
 * them, and how a cell becomes a stored value.
 *
 * Pure and dependency-free, for two reasons. It is the single place the
 * importer and the exporter agree on column names — export writes `header`,
 * import recognises `header` as a synonym of itself, so export → edit →
 * import round-trips. And every conversion here is a money or quantity rule,
 * which is exactly the kind of thing that deserves a test rather than a
 * debugging session six months later.
 *
 * Two scale conversions matter and are easy to get wrong:
 *   - a price column is **rupees** in the file and **paise** in the database
 *   - a quantity column is **units** in the file and **thousandths** in the database
 * A shopkeeper types 10.50 and 2.5; we store 1050 and 2500.
 */
import { QUANTITY_SCALE, rupeesStringToPaise } from '../../lib/money.js';

export type ColumnType = 'text' | 'money' | 'quantity' | 'percent' | 'boolean' | 'itemType';

export interface ColumnDefinition {
  readonly key: string;
  /** What the exporter writes, and the canonical name on the mapping screen. */
  readonly header: string;
  readonly type: ColumnType;
  readonly required: boolean;
  /** Normalised forms that also match this column. `header` is added automatically. */
  readonly synonyms: readonly string[];
}

export const ITEM_COLUMNS: readonly ColumnDefinition[] = [
  {
    key: 'name',
    header: 'Name',
    type: 'text',
    required: true,
    synonyms: ['item', 'itemname', 'product', 'productname', 'particulars', 'description', 'desc'],
  },
  {
    key: 'code',
    header: 'Code',
    type: 'text',
    required: false,
    synonyms: ['itemcode', 'sku', 'skucode', 'articlecode', 'codeno', 'productcode'],
  },
  {
    key: 'barcode',
    header: 'Barcode',
    type: 'text',
    required: false,
    synonyms: ['ean', 'eancode', 'upc', 'barcodeno'],
  },
  {
    key: 'category',
    header: 'Category',
    type: 'text',
    required: false,
    synonyms: ['group', 'itemgroup', 'categoryname', 'groupname'],
  },
  {
    key: 'hsnCode',
    header: 'HSN',
    type: 'text',
    required: false,
    synonyms: ['hsncode', 'hsnsac', 'sac', 'saccode'],
  },
  {
    key: 'unit',
    header: 'Unit',
    type: 'text',
    required: false,
    synonyms: ['uom', 'units', 'unitofmeasure', 'measure'],
  },
  {
    key: 'taxRatePercent',
    header: 'GST %',
    type: 'percent',
    required: false,
    synonyms: ['gst', 'tax', 'gstrate', 'taxrate', 'gstpercent', 'taxpercent', 'igst', 'gstslab'],
  },
  {
    key: 'cessRatePercent',
    header: 'Cess %',
    type: 'percent',
    required: false,
    synonyms: ['cess', 'cessrate', 'cesspercent'],
  },
  {
    key: 'mrp',
    header: 'MRP',
    type: 'money',
    required: false,
    synonyms: ['maxretailprice', 'printedprice', 'listprice'],
  },
  {
    key: 'salePrice',
    header: 'Sale price',
    type: 'money',
    required: false,
    synonyms: ['rate', 'price', 'sellingprice', 'salesrate', 'salerate', 'sp', 'sellprice'],
  },
  {
    key: 'purchasePrice',
    header: 'Purchase price',
    type: 'money',
    required: false,
    synonyms: ['cost', 'costprice', 'buyingprice', 'purchaserate', 'pp', 'landedcost'],
  },
  {
    key: 'openingStock',
    header: 'Opening stock',
    type: 'quantity',
    required: false,
    synonyms: ['stock', 'qty', 'quantity', 'openingqty', 'stockqty', 'openingbalance'],
  },
  {
    key: 'reorderLevel',
    header: 'Reorder level',
    type: 'quantity',
    required: false,
    synonyms: ['reorder', 'minstock', 'minimumstock', 'reorderqty', 'minqty'],
  },
  {
    key: 'itemType',
    header: 'Type',
    type: 'itemType',
    required: false,
    synonyms: ['itemtype', 'goodsservice', 'goodsorservice'],
  },
  {
    key: 'trackStock',
    header: 'Track stock',
    type: 'boolean',
    required: false,
    synonyms: ['maintainstock', 'stocktracking', 'inventory', 'trackinventory'],
  },
];

/** Lowercase, strip everything that is not a letter or digit. "GST %" -> "gst". */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Built once: every synonym, plus each column's own header, to its key. */
const SYNONYM_INDEX: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>();
  for (const column of ITEM_COLUMNS) {
    for (const form of [normaliseHeader(column.header), ...column.synonyms]) {
      // A synonym claimed by two columns would make matching depend on
      // declaration order, which is not something anyone should have to know.
      if (index.has(form) && index.get(form) !== column.key) {
        throw new Error(`Ambiguous import column synonym "${form}".`);
      }
      index.set(form, column.key);
    }
  }
  return index;
})();

export const COLUMN_BY_KEY: ReadonlyMap<string, ColumnDefinition> = new Map(
  ITEM_COLUMNS.map((c) => [c.key, c]),
);

export interface HeaderMatch {
  /** Field key to the zero-based column index it was found at. */
  readonly map: Record<string, number>;
  /** Headers in the file that matched nothing; ignored, but worth showing. */
  readonly unmatched: readonly string[];
  /** Required fields with no column. The file cannot be imported without these. */
  readonly missingRequired: readonly string[];
}

/**
 * Maps a spreadsheet's header row onto field keys.
 *
 * A duplicate column wins on first occurrence rather than last: a file with
 * "Rate" early and "Price" late almost always means the first one, and
 * silently preferring the rightmost is the harder behaviour to explain.
 */
export function matchHeaders(headers: readonly string[]): HeaderMatch {
  const map: Record<string, number> = {};
  const unmatched: string[] = [];

  headers.forEach((header, index) => {
    const normalised = normaliseHeader(header);
    if (normalised === '') return;
    const key = SYNONYM_INDEX.get(normalised);
    if (key === undefined) {
      unmatched.push(header);
      return;
    }
    if (map[key] === undefined) map[key] = index;
  });

  return {
    map,
    unmatched,
    missingRequired: ITEM_COLUMNS.filter((c) => c.required && map[c.key] === undefined).map(
      (c) => c.key,
    ),
  };
}

export type CellValue = string | number | boolean | null | undefined;

export interface ParsedRow {
  readonly values: Record<string, string | number | boolean | null>;
  /** Field key to a message, in the shopkeeper's terms. */
  readonly errors: Record<string, string>;
}

const TRUTHY = new Set(['true', 'yes', 'y', '1']);
const FALSY = new Set(['false', 'no', 'n', '0']);

/**
 * Converts one spreadsheet row into stored values.
 *
 * Collects every problem rather than stopping at the first: a review screen
 * that reveals one bad cell at a time is worse than no review screen.
 */
export function parseItemRow(cells: readonly CellValue[], map: Record<string, number>): ParsedRow {
  const values: Record<string, string | number | boolean | null> = {};
  const errors: Record<string, string> = {};

  for (const column of ITEM_COLUMNS) {
    const index = map[column.key];
    if (index === undefined) continue;

    const raw = cells[index];
    const text = raw === null || raw === undefined ? '' : String(raw).trim();

    if (text === '') {
      if (column.required) errors[column.key] = `${column.header} is required`;
      else values[column.key] = null;
      continue;
    }

    const result = parseCell(column, text);
    if (typeof result === 'string') errors[column.key] = result;
    else values[column.key] = result.value;
  }

  return { values, errors };
}

/** Returns the parsed value, or a message explaining the cell. */
function parseCell(
  column: ColumnDefinition,
  text: string,
): { value: string | number | boolean } | string {
  switch (column.type) {
    case 'text':
      return { value: text };

    case 'money':
      try {
        const paise = rupeesStringToPaise(text, column.header);
        if (paise < 0) return `${column.header} cannot be negative`;
        return { value: paise };
      } catch {
        return `${column.header} must be an amount like 149.50`;
      }

    case 'quantity': {
      // Quantities are decimal in the file (2.5 kg) and thousandths stored.
      // Parsed via the money helper for its exactness, then rescaled: 2.5
      // becomes 250 paise-equivalents, so x10 gives 2500 thousandths.
      const cleaned = text.replace(/,/g, '');
      if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) {
        return `${column.header} must be a quantity like 12 or 2.5`;
      }
      const [whole = '0', fraction = ''] = cleaned.split('.');
      const scaled = Number(whole) * QUANTITY_SCALE + Number(fraction.padEnd(3, '0'));
      if (!Number.isSafeInteger(scaled)) return `${column.header} is too large`;
      return { value: scaled };
    }

    case 'percent': {
      const cleaned = text.replace(/%/g, '').trim();
      const value = Number(cleaned);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return `${column.header} must be a percentage between 0 and 100`;
      }
      return { value };
    }

    case 'boolean': {
      const lower = text.toLowerCase();
      if (TRUTHY.has(lower)) return { value: true };
      if (FALSY.has(lower)) return { value: false };
      return `${column.header} must be Yes or No`;
    }

    case 'itemType': {
      const lower = text.toLowerCase();
      if (lower.startsWith('g')) return { value: 'goods' };
      if (lower.startsWith('s')) return { value: 'service' };
      return `${column.header} must be Goods or Service`;
    }
  }
}
