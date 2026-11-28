import { describe, expect, it } from 'vitest';
import type { Tx } from '../../db/tx.js';
import {
  HSN_6_DIGIT_TURNOVER_PAISE,
  assertHsnOnInvoice,
  hsnRequirementFor,
  hsnShortfalls,
  type HsnLine,
} from './hsn-rule.js';

/** A Tx answering only what the rule asks: turnover rows, and (no) rule sets. */
const txWith = (turnover: { fyStartYear: number; aggregateTurnover: number }[]): Tx =>
  ({
    many: (sql: string) =>
      Promise.resolve(
        sql.includes('entity_turnover_by_fy')
          ? turnover.map((t) => ({ ...t, source: 'declared' }))
          : [],
      ),
  }) as unknown as Tx;

const small = txWith([]);
// FY 2025-26 turnover decides bills dated in FY 2026-27.
const large = txWith([{ fyStartYear: 2025, aggregateTurnover: HSN_6_DIGIT_TURNOVER_PAISE + 1 }]);
const DATE = '2026-11-28';

const line = (name: string, hsnCode?: string): HsnLine => ({ id: name, name, hsnCode });

describe('hsnShortfalls', () => {
  it('a missing HSN fails only where one is required', () => {
    expect(hsnShortfalls([line('Rice')], { mandatory: true, minDigits: 4 })).toEqual([
      { lineId: 'Rice', itemName: 'Rice', hsnCode: null },
    ]);
    expect(hsnShortfalls([line('Rice')], { mandatory: false, minDigits: 4 })).toEqual([]);
  });

  it('a code that is too short, or not digits, fails even where optional', () => {
    expect(
      hsnShortfalls([line('Tea', '09'), line('Soap', 'H001'), line('Oil', '1512')], {
        mandatory: false,
        minDigits: 4,
      }).map((s) => s.itemName),
    ).toEqual(['Tea', 'Soap']);
  });
});

describe('hsnRequirementFor (no rule set published: the notified ₹5 crore)', () => {
  it('up to ₹5 crore: 4 digits, required to a GSTIN holder, optional otherwise', async () => {
    expect(await hsnRequirementFor(small, DATE, 'b2b')).toEqual({ mandatory: true, minDigits: 4 });
    expect(await hsnRequirementFor(small, DATE, 'b2c')).toEqual({
      mandatory: false,
      minDigits: 4,
    });
  });

  it('above ₹5 crore last year: 6 digits on every bill, B2B and B2C', async () => {
    expect(await hsnRequirementFor(large, DATE, 'b2b')).toEqual({ mandatory: true, minDigits: 6 });
    expect(await hsnRequirementFor(large, DATE, 'b2c')).toEqual({ mandatory: true, minDigits: 6 });
  });
});

describe('assertHsnOnInvoice', () => {
  // REGRESSION: the API accepted a B2B bill with no HSN; only the app stopped it.
  it('refuses a B2B bill with an item that has no HSN, naming the item', async () => {
    await expect(
      assertHsnOnInvoice(small, {
        documentDate: DATE,
        buyerHasGstin: true,
        lines: [line('Tea', '0902'), line('India Gate Basmati 1kg')],
      }),
    ).rejects.toMatchObject({
      code: 'HSN_REQUIRED',
      details: {
        minDigits: 4,
        lines: [
          { lineId: 'India Gate Basmati 1kg', itemName: 'India Gate Basmati 1kg', hsnCode: null },
        ],
      },
    });
  });

  it('passes a B2B bill where every item has an HSN', async () => {
    await expect(
      assertHsnOnInvoice(small, {
        documentDate: DATE,
        buyerHasGstin: true,
        lines: [line('Tea', '0902'), line('Rice', '10063020')],
      }),
    ).resolves.toBeUndefined();
  });

  it('a walk-in (B2C) bill of a small business needs no HSN', async () => {
    await expect(
      assertHsnOnInvoice(small, {
        documentDate: DATE,
        buyerHasGstin: false,
        lines: [line('Rice')],
      }),
    ).resolves.toBeUndefined();
  });

  it('a large business needs 6 digits even on a walk-in bill', async () => {
    await expect(
      assertHsnOnInvoice(large, {
        documentDate: DATE,
        buyerHasGstin: false,
        lines: [line('Tea', '0902')],
      }),
    ).rejects.toMatchObject({ code: 'HSN_REQUIRED', details: { minDigits: 6 } });
  });
});
