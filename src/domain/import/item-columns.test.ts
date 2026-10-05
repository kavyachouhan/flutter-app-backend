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
