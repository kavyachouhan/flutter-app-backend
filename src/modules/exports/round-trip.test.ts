/**
 * Export → edit → import has to work, and it only works while the two
 * column lists agree. They live in different files, so this asserts the
 * agreement rather than trusting it: adding a column to one and not the
 * other fails here instead of in a shop's hands.
 */
import { describe, expect, it } from 'vitest';
import { matchHeaders } from '../../domain/import/item-columns.js';
import { CUSTOMER_COLUMN_SET, SUPPLIER_COLUMN_SET } from '../../domain/import/party-columns.js';
import {
  customerExportHeaders,
  itemExportHeaders,
  supplierExportHeaders,
} from './exports.service.js';

describe('items export round-trips through the importer', () => {
  const headers = itemExportHeaders();

  it('writes headers the importer recognises, every one of them', () => {
    const { unmatched } = matchHeaders(headers);
    expect(unmatched).toEqual([]);
  });

  it('writes every required column, so a re-import is never rejected', () => {
    expect(matchHeaders(headers).missingRequired).toEqual([]);
  });

  it('maps each header to a distinct field', () => {
    const { map } = matchHeaders(headers);
    expect(Object.keys(map)).toHaveLength(headers.length);
  });

  it('omits opening stock, which is an instruction rather than a fact', () => {
    // Exporting it would re-apply an opening balance on every re-import,
    // which is a quiet way to corrupt stock.
    expect(headers).not.toContain('Opening stock');
  });
});

describe('customer and supplier exports round-trip through the importer', () => {
  it.each([
    ['customers', customerExportHeaders(), CUSTOMER_COLUMN_SET],
    ['suppliers', supplierExportHeaders(), SUPPLIER_COLUMN_SET],
  ] as const)(
    '%s: every header is recognised, distinct, and covers the required fields',
    (_, headers, set) => {
      const match = set.matchHeaders(headers);
      expect(match.unmatched).toEqual([]);
      expect(match.missingRequired).toEqual([]);
      expect(Object.keys(match.map)).toHaveLength(headers.length);
    },
  );

  it('exports the balance where the importer reads an opening balance', () => {
    expect(
      CUSTOMER_COLUMN_SET.matchHeaders(customerExportHeaders()).map['openingBalance'],
    ).toBeDefined();
    expect(
      SUPPLIER_COLUMN_SET.matchHeaders(supplierExportHeaders()).map['openingBalance'],
    ).toBeDefined();
  });

  it('leaves out the opening date, which is an instruction rather than a fact', () => {
    expect(customerExportHeaders()).not.toContain('Opening date');
  });
});
