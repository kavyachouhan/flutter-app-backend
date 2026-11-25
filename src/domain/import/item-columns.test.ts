import { describe, expect, it } from 'vitest';
import { ITEM_COLUMNS, matchHeaders, normaliseHeader, parseItemRow } from './item-columns.js';

const mapFor = (headers: string[]) => matchHeaders(headers).map;

describe('matchHeaders', () => {
  it('matches the exporter’s own headers, so export → edit → import round-trips', () => {
    const headers = ITEM_COLUMNS.map((c) => c.header);
    const { map, unmatched, missingRequired } = matchHeaders(headers);
    expect(unmatched).toEqual([]);
    expect(missingRequired).toEqual([]);
    expect(Object.keys(map).sort()).toEqual(ITEM_COLUMNS.map((c) => c.key).sort());
  });

  it('matches what a real price list actually calls things', () => {
    const map = mapFor(['Particulars', 'HSN Code', 'Rate', 'GST%', 'Opening Qty']);
    expect(map).toEqual({
      name: 0,
      hsnCode: 1,
      salePrice: 2,
      taxRatePercent: 3,
      openingStock: 4,
    });
  });

  it('ignores punctuation, case and spacing', () => {
    expect(normaliseHeader('  GST % ')).toBe('gst');
    expect(normaliseHeader('HSN/SAC')).toBe('hsnsac');
    expect(mapFor(['item_name'])).toEqual({ name: 0 });
  });

  it('reports a file with no name column rather than importing nameless items', () => {
    expect(matchHeaders(['Rate', 'Qty']).missingRequired).toEqual(['name']);
  });

  it('keeps the first of two columns claiming one field', () => {
    expect(mapFor(['Rate', 'Price'])).toEqual({ salePrice: 0 });
  });

  it('lists headers it did not recognise instead of silently dropping them', () => {
    expect(matchHeaders(['Name', 'Shelf location']).unmatched).toEqual(['Shelf location']);
  });
});

describe('parseItemRow', () => {
  const map = mapFor(['Name', 'Sale price', 'Opening stock', 'GST %', 'Track stock', 'Type']);
  const parse = (cells: (string | number | null)[]) => parseItemRow(cells, map);

  it('converts rupees to paise exactly', () => {
    // The case that breaks Math.round(parseFloat(x) * 100): 1.1*100 is
    // 110.00000000000001, which is how an imported list ends up a paisa off.
    expect(parse(['Tea', '1.10', null, null, null, null]).values['salePrice']).toBe(110);
    expect(parse(['Tea', '₹1,249.99', null, null, null, null]).values['salePrice']).toBe(124999);
  });

  it('converts units to thousandths', () => {
    expect(parse(['Rice', null, '2.5', null, null, null]).values['openingStock']).toBe(2500);
    expect(parse(['Rice', null, '12', null, null, null]).values['openingStock']).toBe(12000);
  });

  it('accepts a percentage written with or without the sign', () => {
    expect(parse(['Tea', null, null, '18%', null, null]).values['taxRatePercent']).toBe(18);
    expect(parse(['Tea', null, null, '5', null, null]).values['taxRatePercent']).toBe(5);
  });

  it('reads Yes/No and Goods/Service the way a shopkeeper writes them', () => {
    const row = parse(['Tea', null, null, null, 'Yes', 'Goods']);
    expect(row.values['trackStock']).toBe(true);
    expect(row.values['itemType']).toBe('goods');
    expect(parse(['Tea', null, null, null, 'N', 'service']).values['trackStock']).toBe(false);
  });

  it('collects every bad cell, not just the first', () => {
    const row = parse(['Tea', 'abc', 'xyz', '200', 'maybe', null]);
    expect(Object.keys(row.errors).sort()).toEqual([
      'openingStock',
      'salePrice',
      'taxRatePercent',
      'trackStock',
    ]);
  });

  it('rejects a negative price rather than storing one', () => {
    expect(parse(['Tea', '-5.00', null, null, null, null]).errors['salePrice']).toBeDefined();
  });

  it('flags a blank name instead of creating an unnamed item', () => {
    expect(parse(['  ', '10.00', null, null, null, null]).errors['name']).toBeDefined();
  });

  it('treats a blank optional cell as "not supplied", not zero', () => {
    const row = parse(['Tea', '', '', '', '', '']);
    expect(row.errors).toEqual({});
    expect(row.values['salePrice']).toBeNull();
  });
});

describe('item files exported by other billing apps', () => {
  /** Vyapar's item export header row, exactly. */
  const VYAPAR_ITEM_HEADERS = [
    'Item Code',
    'Item Name',
    'HSN',
    'Sale Price',
    'Purchase Price',
    'Discount Type',
    'Sale Discount',
    'Current Stock Quantity',
    'Minimum Stock Quantity',
    'Item Location',
    'Tax Rate',
    'Tax Inclusive',
  ];

  it('matches every column we have a field for', () => {
    const match = matchHeaders(VYAPAR_ITEM_HEADERS);
    expect(match.map).toEqual({
      code: 0,
      name: 1,
      hsnCode: 2,
      salePrice: 3,
      purchasePrice: 4,
      discountType: 5,
      discountPercent: 6,
      openingStock: 7,
      reorderLevel: 8,
      taxRatePercent: 10,
      pricesIncludeTax: 11,
    });
    expect(match.unmatched).toEqual(['Item Location']);
  });

  const { map } = matchHeaders(VYAPAR_ITEM_HEADERS);
  const row = (cells: (string | null)[]) => parseItemRow(cells, map);

  it('reads a Vyapar row: GST@5%, Tax Inclusive N, stock below zero', () => {
    const parsed = row([
      'a101',
      'Item 1',
      '0902',
      '20',
      '10',
      'Discount %',
      '0',
      '-10',
      '0',
      'Store 1',
      'GST@5%',
      'N',
    ]);
    expect(parsed.errors).toEqual({});
    expect(parsed.values).toMatchObject({
      code: 'a101',
      salePrice: 2000,
      purchasePrice: 1000,
      taxRatePercent: 5,
      pricesIncludeTax: false,
      openingStock: -10000,
      // A zero discount is no discount, so a re-import reports no change.
      discountPercent: null,
    });
    expect('discountType' in parsed.values).toBe(false);
  });

  it('turns a rupee discount into a percentage of the sale price, and says so', () => {
    const parsed = row([
      'a',
      'Item',
      null,
      '5',
      null,
      'Discount Amount',
      '1',
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(parsed.values['discountPercent']).toBe(20);
    expect(parsed.notes).toEqual(['Discount of ₹1 saved as 20% of the sale price']);
  });

  it('keeps a percentage discount as it is', () => {
    const parsed = row([
      'a',
      'Item',
      null,
      '10',
      null,
      'Discount %',
      '2',
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(parsed.values['discountPercent']).toBe(2);
    expect(parsed.notes).toEqual([]);
  });

  it('refuses a rupee discount it cannot turn into a percentage', () => {
    expect(
      row(['a', 'Item', null, null, null, 'Discount Amount', '5', null, null, null, null, null])
        .errors['discountPercent'],
    ).toBeDefined();
    expect(
      row(['a', 'Item', null, '5', null, 'Discount Amount', '6', null, null, null, null, null])
        .errors['discountPercent'],
    ).toBeDefined();
    expect(
      row(['a', 'Item', null, '5', null, 'Discount %', '150', null, null, null, null, null]).errors[
        'discountPercent'
      ],
    ).toBeDefined();
  });
});

describe('rules the database enforces, caught while checking rows', () => {
  const { map } = matchHeaders(['Name', 'HSN', 'Type', 'Track stock', 'Opening stock']);
  const parse = (cells: (string | null)[]) => parseItemRow(cells, map);

  it('REGRESSION: a service is saved without stock tracking — the database refuses a service that tracks it', () => {
    const parsed = parse(['Home delivery', null, 'Service', null, '5']);
    expect(parsed.errors).toEqual({});
    expect(parsed.values['trackStock']).toBe(false);
    expect(parsed.values['openingStock']).toBeNull();
    expect(parsed.notes).toEqual(['A service has no stock, so its opening stock is not recorded']);
  });

  it('refuses a service that the file says tracks stock', () => {
    expect(
      parse(['Home delivery', null, 'Service', 'Yes', null]).errors['trackStock'],
    ).toBeDefined();
  });

  it('puts back the leading zero Excel drops from an HSN code', () => {
    expect(parse(['Tea', '902', null, null, null]).values['hsnCode']).toBe('0902');
    expect(parse(['Tea', '30049099', null, null, null]).values['hsnCode']).toBe('30049099');
  });

  it("refuses an HSN that is not 4 to 8 digits, like Vyapar's sample H001", () => {
    expect(parse(['Tea', 'H001', null, null, null]).errors['hsnCode']).toBeDefined();
    expect(parse(['Tea', '12', null, null, null]).errors['hsnCode']).toBeDefined();
    expect(parse(['Tea', '123456789', null, null, null]).errors['hsnCode']).toBeDefined();
  });
});
