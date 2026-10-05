import { describe, expect, it } from 'vitest';
import { chooseSymbology, resolveLabels, wrapName, type LabelItem } from './resolve.js';
import { LABEL_TEMPLATES } from './templates.js';

describe('chooseSymbology', () => {
  it('recognises a real EAN-13', () => {
    // Parle-G style GS1 code with a correct check digit.
    expect(chooseSymbology('8901719101045')).toEqual({
      value: '8901719101045',
      symbology: 'ean13',
      isRetailCode: true,
    });
  });

  it('falls back to Code 128 for a 13-digit code with a bad check digit', () => {
    // The important case: shops use 13-digit internal codes that are not
    // valid EAN. Encoding one as ean13 prints a label that scans as a
    // different product, because the renderer "fixes" the last digit.
    const result = chooseSymbology('8901719101046');
    expect(result.symbology).toBe('code128');
    expect(result.isRetailCode).toBe(false);
    expect(result.value).toBe('8901719101046');
  });

  it('recognises UPC-A and EAN-8', () => {
    expect(chooseSymbology('036000291452').symbology).toBe('upca');
    expect(chooseSymbology('96385074').symbology).toBe('ean8');
  });

  it('uses Code 128 for anything with letters or an odd length', () => {
    expect(chooseSymbology('ITEM-001').symbology).toBe('code128');
    expect(chooseSymbology('12345').symbology).toBe('code128');
  });
});

describe('wrapName', () => {
  it('keeps a short name on one line', () => {
    expect(wrapName('Parle-G 100g', 22, 2)).toEqual(['Parle-G 100g']);
  });

  it('wraps on word boundaries', () => {
    expect(wrapName('Tata Salt Lite Low Sodium', 12, 2)).toEqual(['Tata Salt', 'Lite Low…']);
  });

  it('marks truncation so a cut name is not read as the whole name', () => {
    const lines = wrapName('Aashirvaad Select Sharbati Atta 10 kg Pack', 14, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
  });

  it('hard-breaks a single word longer than the label', () => {
    expect(wrapName('ABCDEFGHIJKLMNOP', 6, 2)).toEqual(['ABCDEF', 'GHIJK…']);
  });

  it('returns nothing for a blank name rather than a line of spaces', () => {
    expect(wrapName('   ', 20, 2)).toEqual([]);
  });
});

describe('resolveLabels', () => {
  const item = (over: Partial<LabelItem> = {}): LabelItem => ({
    itemId: '11111111-1111-4111-8111-111111111111',
    name: 'Parle-G 100g',
    unit: 'pkt',
    code: 'PG100',
    barcodes: ['8901719101045'],
    mrp: 1000,
    salePrice: 950,
    ...over,
  });

  const resolve = (
    items: { item: LabelItem; copies: number }[],
    priceField: 'mrp' | 'salePrice' | 'none' = 'mrp',
  ) =>
    resolveLabels({
      items,
      template: LABEL_TEMPLATES.a4_38x25_3up,
      priceField,
      currencySymbol: '₹',
    });

  it('formats the price server-side, so the device never does currency maths', () => {
    const { labels } = resolve([{ item: item(), copies: 3 }]);
    expect(labels[0]?.priceText).toBe('MRP ₹10.00');
    expect(labels[0]?.copies).toBe(3);
  });

  it('uses the sale price when asked, without the MRP prefix', () => {
    expect(resolve([{ item: item(), copies: 1 }], 'salePrice').labels[0]?.priceText).toBe('₹9.50');
  });

  it('falls back to the sale price when an item has no MRP, and drops the MRP wording', () => {
    // MRP is a declaration under the Legal Metrology Act, not a synonym for
    // "the price". Printing the shop's own rate under that word would be a
    // misstatement on a sticker that goes on a physical packet.
    expect(resolve([{ item: item({ mrp: null }), copies: 1 }]).labels[0]?.priceText).toBe('₹9.50');
  });

  it('prefers the shop’s barcode over the internal code', () => {
    expect(resolve([{ item: item(), copies: 1 }]).labels[0]?.barcode.value).toBe('8901719101045');
  });

  it('falls back to the item code when there is no barcode', () => {
    const { labels } = resolve([{ item: item({ barcodes: [] }), copies: 1 }]);
    expect(labels[0]?.barcode).toMatchObject({ value: 'PG100', symbology: 'code128' });
  });

  it('names an item it cannot label instead of printing a blank sticker', () => {
    const { labels, errors } = resolve([
      { item: item({ barcodes: [], code: null, name: 'Loose rice' }), copies: 5 },
    ]);
    expect(labels).toEqual([]);
    expect(errors[0]).toMatchObject({ name: 'Loose rice' });
  });

  it('counts the sheet, not the rows', () => {
    const { totalLabels } = resolve([
      { item: item(), copies: 12 },
      { item: item({ itemId: '22222222-2222-4222-8222-222222222222' }), copies: 3 },
    ]);
    expect(totalLabels).toBe(15);
  });

  it('omits the barcode digits on a template too narrow for them', () => {
    const { labels } = resolveLabels({
      items: [{ item: item(), copies: 1 }],
      template: LABEL_TEMPLATES.roll_38x25_2up,
      priceField: 'mrp',
      currencySymbol: '₹',
    });
    expect(labels[0]?.barcodeText).toBeNull();
    expect(labels[0]?.secondaryText).toBeNull();
  });
});
