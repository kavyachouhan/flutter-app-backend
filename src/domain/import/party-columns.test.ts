import { describe, expect, it } from 'vitest';
import { CUSTOMER_COLUMN_SET, SUPPLIER_COLUMN_SET, parsePartyRow } from './party-columns.js';

/** The header row of Vyapar's party import sample, exactly. */
const VYAPAR_PARTY_HEADERS = [
  'Name*',
  'Contact No.',
  'Email ID',
  'Address',
  'Opening Balance',
  'Opening Date (dd/MM/yyyy)',
  'GSTIN',
  'Shipping Address',
];

describe('party columns', () => {
  it("matches every column of Vyapar's party file we have a field for", () => {
    const match = CUSTOMER_COLUMN_SET.matchHeaders(VYAPAR_PARTY_HEADERS);
    expect(match.map).toEqual({
      name: 0,
      phone: 1,
      email: 2,
      addressLine1: 3,
      openingBalance: 4,
      openingDate: 5,
      gstin: 6,
    });
    // No shipping address field: said, not silently dropped.
    expect(match.unmatched).toEqual(['Shipping Address']);
    expect(match.missingRequired).toEqual([]);
  });

  it('reads a Vyapar party row into stored values', () => {
    const { map } = CUSTOMER_COLUMN_SET.matchHeaders(VYAPAR_PARTY_HEADERS);
    const row = parsePartyRow(
      CUSTOMER_COLUMN_SET,
      [
        'Party 1',
        '1234567890',
        'abc@xyz.com',
        'XYZ Street, Bangalore',
        '200',
        '26/08/2016',
        '29ABCDE0000A1ZK',
        'XYZ Street',
      ],
      map,
    );
    expect(row.errors).toEqual({});
    expect(row.values).toMatchObject({
      name: 'Party 1',
      phone: '1234567890',
      email: 'abc@xyz.com',
      openingBalance: 20000,
      openingDate: '2016-08-26',
      gstin: '29ABCDE0000A1ZK',
    });
  });

  it('reads the state off the GSTIN when the file has no state column', () => {
    const { map } = CUSTOMER_COLUMN_SET.matchHeaders(['Name', 'GSTIN']);
    expect(
      parsePartyRow(CUSTOMER_COLUMN_SET, ['A', '27ABCDE0000A1ZO'], map).values['stateCode'],
    ).toBe('27');
  });

  // REGRESSION: the file's state used to win, and the database (customers_gstin_valid)
  // then refused the row on Save, after the review had shown it as fine.
  it("uses the GSTIN's state when the State column disagrees, and says so", () => {
    const { map } = CUSTOMER_COLUMN_SET.matchHeaders(['Name', 'GSTIN', 'State']);
    const row = parsePartyRow(CUSTOMER_COLUMN_SET, ['A', '27ABCDE0000A1ZO', 'Goa'], map);
    expect(row.errors).toEqual({});
    expect(row.values['stateCode']).toBe('27');
    expect(row.notes).toEqual(['State 30 changed to 27, the state the GSTIN is registered in']);
  });

  it('keeps the State column when it agrees with the GSTIN, with no note', () => {
    const { map } = CUSTOMER_COLUMN_SET.matchHeaders(['Name', 'GSTIN', 'State']);
    const row = parsePartyRow(CUSTOMER_COLUMN_SET, ['A', '27ABCDE0000A1ZO', 'Maharashtra'], map);
    expect(row.values['stateCode']).toBe('27');
    expect(row.notes).toEqual([]);
  });

  it('drops an opening date that has no balance to date', () => {
    const { map } = CUSTOMER_COLUMN_SET.matchHeaders(['Name', 'Opening balance', 'Opening date']);
    const row = parsePartyRow(CUSTOMER_COLUMN_SET, ['A', '0', '26/08/2016'], map);
    expect(row.values['openingBalance']).toBeNull();
    expect(row.values['openingDate']).toBeNull();
  });

  it('gives a customer a credit limit and a supplier payment terms', () => {
    expect(CUSTOMER_COLUMN_SET.byKey.has('creditLimit')).toBe(true);
    expect(CUSTOMER_COLUMN_SET.byKey.has('paymentTermsDays')).toBe(false);
    expect(SUPPLIER_COLUMN_SET.byKey.has('paymentTermsDays')).toBe(true);
    expect(SUPPLIER_COLUMN_SET.matchHeaders(['Vendor Name', 'Credit Days']).map).toEqual({
      name: 0,
      paymentTermsDays: 1,
    });
  });

  it('requires a name', () => {
    expect(CUSTOMER_COLUMN_SET.matchHeaders(['Phone']).missingRequired).toEqual(['name']);
    const { map } = CUSTOMER_COLUMN_SET.matchHeaders(['Name', 'Phone']);
    expect(
      parsePartyRow(CUSTOMER_COLUMN_SET, ['  ', '9876543210'], map).errors['name'],
    ).toBeDefined();
  });
});
