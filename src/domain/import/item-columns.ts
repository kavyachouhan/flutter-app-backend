/**
 * The item spreadsheet contract: which columns exist, what a shop (or the
 * software it is leaving) calls them, and how a cell becomes a stored value.
 *
 * This is the single place the importer and the exporter agree on column
 * names — export writes `header`, import recognises `header` as a synonym of
 * itself, so export → edit → import round-trips.
 *
 * Two scale conversions matter and are easy to get wrong:
 *   - a price column is **rupees** in the file and **paise** in the database
 *   - a quantity column is **units** in the file and **thousandths** in the database
 * A shopkeeper types 10.50 and 2.5; we store 1050 and 2500.
 *
 * The synonyms include what Vyapar and myBillBook write ("Opening Stock
 * Quantity", "Minimum Stock Quantity", "Tax Inclusive", "Sale Discount"), so
 * their exports import without the shop renaming a column.
 */
import {
  defineColumns,
  normaliseHeader,
  type CellValue,
  type ColumnDefinition,
  type ColumnType,
  type HeaderMatch,
  type ParsedRow,
} from './columns.js';

export { normaliseHeader };
export type { CellValue, ColumnDefinition, ColumnType, HeaderMatch, ParsedRow };

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
    synonyms: ['group', 'itemgroup', 'categoryname', 'groupname', 'itemcategory'],
  },
  {
    key: 'hsnCode',
    header: 'HSN',
    type: 'hsn',
    required: false,
    synonyms: ['hsncode', 'hsnsac', 'sac', 'saccode'],
  },
  {
    key: 'unit',
    header: 'Unit',
    type: 'text',
    required: false,
    synonyms: ['uom', 'units', 'unitofmeasure', 'measure', 'baseunit', 'primaryunit'],
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
    synonyms: [
      'rate',
      'price',
      'sellingprice',
      'salesrate',
      'salerate',
      'sp',
      'sellprice',
      'salesprice',
    ],
  },
  {
    key: 'purchasePrice',
    header: 'Purchase price',
    type: 'money',
    required: false,
    synonyms: ['cost', 'costprice', 'buyingprice', 'purchaserate', 'pp', 'landedcost'],
  },
  {
    key: 'pricesIncludeTax',
    header: 'Prices include tax',
    type: 'boolean',
    required: false,
    synonyms: [
      'taxinclusive',
      'inclusiveoftax',
      'inclusivetax',
      'priceincludestax',
      'taxincluded',
      'withtax',
      'salepricetaxinclusive',
    ],
  },
  {
    key: 'discountPercent',
    header: 'Discount %',
    type: 'decimal',
    required: false,
    synonyms: ['salediscount', 'discountpercent', 'discpercent', 'disc', 'discountrate'],
  },
  {
    key: 'discountType',
    header: 'Discount type',
    type: 'discountType',
    required: false,
    transient: true,
    synonyms: ['disctype', 'salediscounttype'],
  },
  {
    key: 'openingStock',
    header: 'Opening stock',
    type: 'quantity',
    required: false,
    // Another app's export can carry stock below zero; refusing the row
    // would drop the item along with the number.
    signed: true,
    createOnly: true,
    synonyms: [
      'stock',
      'qty',
      'quantity',
      'openingqty',
      'stockqty',
      'openingbalance',
      'openingstockquantity',
      'openingstockqty',
      'currentstock',
      'currentstockquantity',
      'currentqty',
      'closingstock',
      'stockquantity',
      'instock',
    ],
  },
  {
    key: 'reorderLevel',
    header: 'Reorder level',
    type: 'quantity',
    required: false,
    synonyms: [
      'reorder',
      'minstock',
      'minimumstock',
      'reorderqty',
      'minqty',
      'minimumstockquantity',
      'minstockquantity',
      'minimumqty',
      'lowstock',
      'lowstocklevel',
      'alertquantity',
    ],
  },
  {
    key: 'itemType',
    header: 'Type',
    type: 'itemType',
    required: false,
    synonyms: ['itemtype', 'goodsservice', 'goodsorservice', 'producttype'],
  },
  {
    key: 'trackStock',
    header: 'Track stock',
    type: 'boolean',
    required: false,
    synonyms: ['maintainstock', 'stocktracking', 'inventory', 'trackinventory'],
  },
];

export const ITEM_COLUMN_SET = defineColumns(ITEM_COLUMNS);

export const COLUMN_BY_KEY = ITEM_COLUMN_SET.byKey;

export function matchHeaders(headers: readonly string[]): HeaderMatch {
  return ITEM_COLUMN_SET.matchHeaders(headers);
}

/**
 * Converts one item row into stored values.
 *
 * On top of the per-cell rules it settles the discount, which other apps
 * export as a pair: a type ("Discount %" / "Discount Amount") and a number.
 * We store a percentage, so a rupee discount is converted against the sale
 * price — and the review screen says so.
 */
export function parseItemRow(cells: readonly CellValue[], map: Record<string, number>): ParsedRow {
  const parsed = ITEM_COLUMN_SET.parseRow(cells, map);
  const values = { ...parsed.values };
  const errors = { ...parsed.errors };
  const notes = [...parsed.notes];

  const discount = values['discountPercent'];
  const type = values['discountType'];
  delete values['discountType'];

  if (typeof discount === 'number' && errors['discountPercent'] === undefined) {
    if (discount === 0) {
      // "No discount" is stored as none, so a re-import does not report a
      // change on every item whose discount was never set.
      values['discountPercent'] = null;
    } else if (type === 'amount') {
      const salePrice = values['salePrice'];
      if (typeof salePrice !== 'number' || salePrice <= 0) {
        errors['discountPercent'] = 'A discount in rupees needs a sale price to work out the %';
      } else {
        const percent = Math.round(((discount * 100) / salePrice) * 100 * 100) / 100;
        if (percent > 100) {
          errors['discountPercent'] = 'The discount is more than the sale price';
        } else {
          values['discountPercent'] = percent;
          notes.push(`Discount of ₹${discount} saved as ${percent}% of the sale price`);
        }
      }
    } else if (discount > 100) {
      errors['discountPercent'] = 'Discount % must be between 0 and 100';
    }
  }

  // A service has no stock: the database refuses one that tracks it.
  if (values['itemType'] === 'service') {
    if (values['trackStock'] === true) {
      errors['trackStock'] = 'A service cannot track stock';
    } else {
      values['trackStock'] = false;
      if (typeof values['openingStock'] === 'number' && values['openingStock'] !== 0) {
        notes.push('A service has no stock, so its opening stock is not recorded');
      }
      values['openingStock'] = null;
    }
  }

  return { values, errors, notes };
}
