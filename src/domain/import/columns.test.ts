import { describe, expect, it } from 'vitest';
import { gstinCheckDigit, parseCell, type ColumnDefinition, type ColumnType } from './columns.js';

const column = (type: ColumnType, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  key: 'x',
  header: 'Field',
  type,
  required: false,
  synonyms: [],
  ...extra,
});
const value = (type: ColumnType, text: string, extra: Partial<ColumnDefinition> = {}) => {
  const result = parseCell(column(type, extra), text);
  return typeof result === 'string' ? { error: result } : result.value;
};

describe('parseCell', () => {
  it('reads a GST rate the way other billing apps export it', () => {
    expect(value('percent', 'GST@5%')).toBe(5);
    expect(value('percent', 'IGST@0%')).toBe(0);
    expect(value('percent', 'GST@0.25%')).toBe(0.25);
    expect(value('percent', 'GST 18%')).toBe(18);
    expect(value('percent', '12')).toBe(12);
    expect(value('percent', 'abc')).toHaveProperty('error');
    expect(value('percent', '120%')).toHaveProperty('error');
  });

  it('allows stock below zero only where the column says so', () => {
    expect(value('quantity', '-10', { signed: true })).toBe(-10000);
    expect(value('quantity', '2.5', { signed: true })).toBe(2500);
    expect(value('quantity', '-10')).toHaveProperty('error');
  });

  it('keeps the sign of a balance, including the (500) accounts style', () => {
    expect(value('signedMoney', '200')).toBe(20000);
    expect(value('signedMoney', '-150.50')).toBe(-15050);
    expect(value('signedMoney', '(500)')).toBe(-50000);
    expect(value('money', '-5')).toHaveProperty('error');
  });

  it('reads dates day-first, as Indian software writes them', () => {
    expect(value('date', '26/08/2016')).toBe('2016-08-26');
    expect(value('date', '08-08-2016')).toBe('2016-08-08');
    expect(value('date', '2016-08-26')).toBe('2016-08-26');
    expect(value('date', '31/02/2016')).toHaveProperty('error');
    expect(value('date', 'yesterday')).toHaveProperty('error');
  });

  it('refuses an opening date in the future', () => {
    const next = new Date();
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    const text = `01/01/${next.getUTCFullYear()}`;
    expect(value('date', text)).toEqual({ error: 'Field cannot be in the future' });
  });

  it('turns a state name, a code, or both into the 2-digit GST code', () => {
    expect(value('state', 'Karnataka')).toBe('29');
    expect(value('state', '29')).toBe('29');
    expect(value('state', '29 - Karnataka')).toBe('29');
    expect(value('state', '7')).toBe('07');
    expect(value('state', 'tamil nadu')).toBe('33');
    expect(value('state', 'Andaman & Nicobar Islands')).toBe('35');
    expect(value('state', 'Atlantis')).toHaveProperty('error');
  });

  it('checks a GSTIN and an email, and tidies their case', () => {
    expect(value('gstin', '29abcde0000a1zk')).toBe('29ABCDE0000A1ZK');
    expect(value('gstin', '29ABCDE')).toHaveProperty('error');
  });

  // REGRESSION: a GSTIN with the right shape but a wrong check digit passed the
  // review, then the database (app.gstin_valid) refused the row on Save.
  it('refuses a GSTIN whose check digit is wrong, or whose state code does not exist', () => {
    expect(value('gstin', '27AAACG1111A1ZM')).toBe('27AAACG1111A1ZM');
    expect(value('gstin', '27AAACG1111A1Z5')).toEqual({
      error: 'Field 27AAACG1111A1Z5 has a typo: its last character does not match the rest',
    });
    expect(value('gstin', '45AAACG1111A1ZM')).toHaveProperty('error');
    // The example the "wrong shape" message shows must itself be valid.
    expect(value('gstin', '29ABCDE1234F1ZW')).toBe('29ABCDE1234F1ZW');
  });

  it('computes the GSTIN check digit the way GSTN does', () => {
    expect(gstinCheckDigit('24AABCS2222B1Z')).toBe('7');
    expect(gstinCheckDigit('29ABCDE0000A1Z')).toBe('K');
    expect(value('email', 'Abc@XYZ.com')).toBe('abc@xyz.com');
    expect(value('email', 'not-an-email')).toHaveProperty('error');
  });

  it('reads a phone number Excel stored as a number', () => {
    expect(value('phone', '1234567890.0')).toBe('1234567890');
    expect(value('phone', '+91 98765 43210')).toBe('+91 98765 43210');
    expect(value('phone', '123')).toHaveProperty('error');
  });

  it('refuses a text cell that is a spreadsheet formula', () => {
    expect(value('text', '=HYPERLINK("http://x","click")')).toHaveProperty('error');
    expect(value('text', '+91 shop')).toBe('+91 shop');
  });

  it('reads "Discount %" and "Discount Amount" as the two discount kinds', () => {
    expect(value('discountType', 'Discount %')).toBe('percent');
    expect(value('discountType', 'Discount Amount')).toBe('amount');
    expect(value('discountType', 'maybe')).toHaveProperty('error');
  });
});
