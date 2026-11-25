import { describe, expect, it } from 'vitest';
import { customersKind, decide, itemsKind, type Judgement, type ParsedChunkRow } from './kinds.js';

const row = (
  rowNo: number,
  values: ParsedChunkRow['values'],
  errors: Record<string, string> = {},
): ParsedChunkRow => ({
  rowNo,
  values,
  errors,
  notes: [],
});

const judgement = (
  parsed: ParsedChunkRow,
  match: Judgement['match'] = null,
  dedupeKeys: string[] = [],
): Judgement => ({ rowNo: parsed.rowNo, parsed, match, dedupeKeys });

describe('decide', () => {
  it('makes a row with a bad cell an error, and keeps the message', () => {
    const result = decide(
      itemsKind,
      judgement(row(2, { name: 'Tea' }, { salePrice: 'bad' })),
      new Set(),
      new Map(),
    );
    expect(result.action).toBe('error');
    expect(result.errors).toEqual({ salePrice: 'bad' });
  });

  it('creates an unmatched row, and refuses a second row that would create the same customer', () => {
    const claimed = new Map<string, number>();
    const first = decide(
      customersKind,
      judgement(row(2, { name: 'A', phone: '911234567890' }), null, ['phone:911234567890']),
      new Set(),
      claimed,
    );
    const second = decide(
      customersKind,
      judgement(row(5, { name: 'B', phone: '911234567890' }), null, ['phone:911234567890']),
      new Set(),
      claimed,
    );
    expect(first.action).toBe('create');
    expect(first.dedupeKeys).toEqual(['phone:911234567890']);
    expect(second.action).toBe('error');
    expect(second.errors).toEqual({
      phone: 'Row 2 of this file already adds a customer with the same phone number',
    });
  });

  it('updates a matched record with only what changed', () => {
    const existing = { id: 'c1', name: 'Asha', phone: '911234567890', email: null, city: 'Pune' };
    const result = decide(
      customersKind,
      judgement(row(3, { name: 'Asha', phone: '911234567890', city: 'Mumbai', email: null }), {
        id: 'c1',
        rule: 'phone',
        existing,
      }),
      new Set(),
      new Map(),
    );
    expect(result.action).toBe('update');
    expect(result.matchRule).toBe('phone');
    // A blank email in the file is not an instruction to clear the stored one.
    expect(result.diff).toEqual({ city: { from: 'Pune', to: 'Mumbai' } });
  });

  it('skips an unchanged record, but says the opening balance was not applied to it', () => {
    const existing = { id: 'c1', name: 'Asha', phone: '911234567890' };
    const result = decide(
      customersKind,
      judgement(row(3, { name: 'Asha', phone: '911234567890', openingBalance: 50000 }), {
        id: 'c1',
        rule: 'phone',
        existing,
      }),
      new Set(),
      new Map(),
    );
    expect(result.action).toBe('skip');
    expect(result.notes).toEqual([
      'Opening balance is only used for a new customer; this one already exists',
    ]);
  });

  it('refuses a second row updating the same existing record', () => {
    const claimed = new Set<string>();
    const match = {
      id: 'i1',
      rule: 'code' as const,
      existing: { id: 'i1', name: 'Tea', salePrice: 1000, barcodes: [] },
    };
    expect(
      decide(
        itemsKind,
        judgement(row(2, { name: 'Tea', salePrice: 1200 }), match),
        claimed,
        new Map(),
      ).action,
    ).toBe('update');
    expect(
      decide(
        itemsKind,
        judgement(row(3, { name: 'Tea', salePrice: 1300 }), match),
        claimed,
        new Map(),
      ).action,
    ).toBe('error');
  });

  it('counts an added barcode as a change to an item', () => {
    const match = {
      id: 'i1',
      rule: 'code' as const,
      existing: { id: 'i1', name: 'Tea', barcodes: ['111'] },
    };
    const result = decide(
      itemsKind,
      judgement(row(2, { name: 'Tea', barcode: '222' }), match),
      new Set(),
      new Map(),
    );
    expect(result.action).toBe('update');
    expect(result.diff).toEqual({ barcode: { from: ['111'], to: '222' } });
  });

  it('compares a NUMERIC that pg returns as text by value, not as a string', () => {
    const match = {
      id: 'i1',
      rule: 'code' as const,
      existing: { id: 'i1', name: 'Tea', taxRatePercent: '18.000', barcodes: [] },
    };
    const result = decide(
      itemsKind,
      judgement(row(2, { name: 'Tea', taxRatePercent: 18 }), match),
      new Set(),
      new Map(),
    );
    expect(result.action).toBe('skip');
  });
});

describe('party parse', () => {
  const map = customersKind.columns.matchHeaders(['Name', 'Phone']).map;

  it('normalises a phone number the way the customer screen does', () => {
    expect(customersKind.parse(['Asha', '98765 43210'], map).values['phone']).toBe('919876543210');
  });

  it('turns an unusable phone number into a row error, not a crash', () => {
    expect(customersKind.parse(['Asha', '12345678901234'], map).errors['phone']).toBe(
      'Phone must be a valid mobile number',
    );
  });
});
