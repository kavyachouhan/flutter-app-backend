import { describe, expect, it } from 'vitest';
import {
  ZERO,
  lastClaimPeriod,
  runItcPeriod,
  runItcPeriodAfter,
  type ItcDocument,
  type ItcPeriodInput,
} from './itc-engine.js';
import type { TaxAmounts } from './returns/model.js';

const t = (igst: number, cgst = 0, sgst = 0, cess = 0): TaxAmounts => ({ igst, cgst, sgst, cess });

const doc = (over: Partial<ItcDocument> = {}): ItcDocument => ({
  registerId: 'r1',
  sourceType: 'purchase_bill',
  number: 'B/1',
  supplierGstin: '29AABCU9603R1ZX',
  documentDate: '2026-05-10',
  receivedDate: null,
  receiptComplete: true,
  kind: 'domestic',
  blocked: null,
  use: 'business_taxable',
  capitalGoods: false,
  tax: t(1_800),
  payable: 11_800,
  returned: 0,
  payments: [{ date: '2026-05-10', amount: 11_800 }],
  twoB: { period: '2026-05', available: true, tax: t(1_800) },
  twoBTracked: true,
  history: { claimed: ZERO, reversedTemporary: ZERO, reclaimed: ZERO, closed: false },
  ...over,
});

const run = (documents: ItcDocument[], over: Partial<ItcPeriodInput> = {}) =>
  runItcPeriod({
    period: { year: 2026, month: 5 },
    documents,
    commonCapitalGoods: [],
    turnover: { exempt: 0, total: 100 },
    ...over,
  });

describe('ITC engine: claiming (s.16)', () => {
  it('claims domestic credit in 4(A)(5) when it is in GSTR-2B', () => {
    const r = run([doc()]);
    expect(r.table4.available.other).toEqual(t(1_800));
    expect(r.movements).toHaveLength(1);
    expect(r.pending).toHaveLength(0);
  });

  it('limits the claim to what 2B shows, head by head (s.16(2)(aa))', () => {
    const r = run([doc({ twoB: { period: '2026-05', available: true, tax: t(1_500) } })]);
    expect(r.table4.available.other).toEqual(t(1_500));
    expect(r.issues.map((i) => i.code)).toContain('itc_limited_to_2b');
  });

  it('carries a bill not yet in 2B forward as pending', () => {
    const r = run([doc({ twoB: null })]);
    expect(r.table4.available.other).toEqual(ZERO);
    expect(r.pending[0]).toMatchObject({ reason: 'not_in_2b', lastClaimPeriod: '2027-10' });
  });

  it('follows the books, with a warning, for months without an imported 2B', () => {
    const r = run([doc({ twoB: null, twoBTracked: false })]);
    expect(r.table4.available.other).toEqual(t(1_800));
    expect(r.issues.map((i) => i.code)).toContain('itc_without_2b');
  });

  it('waits for goods received and for the last lot', () => {
    expect(run([doc({ receivedDate: '2026-06-02' })]).pending[0]?.reason).toBe('goods_not_received');
    expect(run([doc({ receiptComplete: false })]).pending[0]?.reason).toBe('receipt_incomplete');
  });

  it('reports 2B "not available" credit in 4(D)(2), not 4(A)', () => {
    const r = run([doc({ twoB: { period: '2026-05', available: false, tax: t(1_800) } })]);
    expect(r.table4.available.other).toEqual(ZERO);
    expect(r.table4.ineligible.section_16_4_or_pos).toEqual(t(1_800));
  });

  it('puts reverse charge in 4(A)(3) and imports in 4(A)(1)/(2) without waiting for 2B', () => {
    const r = run([
      doc({ registerId: 'a', kind: 'rcm_domestic', twoB: null }),
      doc({ registerId: 'b', kind: 'import_goods', twoB: null }),
      doc({ registerId: 'c', kind: 'rcm_import_services', twoB: null }),
    ]);
    expect(r.table4.available.reverse_charge).toEqual(t(1_800));
    expect(r.table4.available.import_goods).toEqual(t(1_800));
    expect(r.table4.available.import_services).toEqual(t(1_800));
  });

  it('sends credit to 4(D)(2) once the s.16(4) limit has passed', () => {
    expect(lastClaimPeriod('2025-03-31')).toBe('2025-10');
    expect(lastClaimPeriod('2025-04-01')).toBe('2026-10');
    const r = run([doc({ documentDate: '2024-05-01', twoB: null })], {
      period: { year: 2026, month: 5 },
    });
    expect(r.table4.ineligible.section_16_4_or_pos).toEqual(t(1_800));
    expect(r.movements[0]?.rule).toBe('s16_4');
  });

  it('skips documents already settled by earlier returns', () => {
    const r = run([
      doc({ history: { claimed: t(1_800), reversedTemporary: ZERO, reclaimed: ZERO, closed: true } }),
    ]);
    expect(r.movements).toHaveLength(0);
  });

  it('nets a debit note in the period of the note', () => {
    const r = run([doc({ sourceType: 'debit_note', tax: t(-300), twoB: null })]);
    expect(r.table4.available.other).toEqual(t(-300));
  });
});

describe('ITC engine: blocked and apportioned credit', () => {
  it('reports s.17(5) credit in 4(A) and reverses it in 4(B)(1)', () => {
    const r = run([doc({ blocked: 's17_5_b_i' })]);
    expect(r.table4.available.other).toEqual(t(1_800));
    expect(r.table4.reversed.rules_38_42_43_17_5).toEqual(t(1_800));
    expect(r.movements[1]?.note).toContain('s.17(5)(b)(i)');
  });

  it('reverses exempt-only use under Rule 42 and capital goods under Rule 43', () => {
    const r = run([
      doc({ registerId: 'a', use: 'exempt_only' }),
      doc({ registerId: 'b', use: 'non_business', capitalGoods: true }),
    ]);
    expect(r.movements.filter((m) => m.line === 'b1').map((m) => m.rule)).toEqual([
      'rule_42',
      'rule_43',
    ]);
  });

  it('works out Rule 42 D1 and D2 on common credit', () => {
    const r = run([doc({ use: 'common_with_non_business', tax: t(10_000), twoB: { period: '2026-05', available: true, tax: t(10_000) }, payable: 0 })], {
      turnover: { exempt: 25, total: 100 },
    });
    const b1 = r.movements.filter((m) => m.line === 'b1');
    expect(b1.map((m) => m.tax.igst)).toEqual([2_500, 500]);
  });

  it('works out Rule 43 Te on common capital goods within five years', () => {
    const r = run([], {
      turnover: { exempt: 50, total: 100 },
      commonCapitalGoods: [
        { registerId: 'cg', documentDate: '2023-01-15', tax: t(60_000) },
        { registerId: 'old', documentDate: '2021-04-01', tax: t(60_000) },
      ],
    });
    // Only the 2023 item is in its useful life: 60,000 / 60 x 50%.
    expect(r.table4.reversed.rules_38_42_43_17_5).toEqual(t(500));
  });
});

describe('ITC engine: Rule 37 (payment within 180 days)', () => {
  const claimedBill = (payments: { date: string; amount: number }[]) =>
    doc({
      documentDate: '2025-10-01',
      payments,
      history: { claimed: t(1_800), reversedTemporary: ZERO, reclaimed: ZERO, closed: false },
    });

  it('reverses in 4(B)(2) the share of credit for value unpaid after 180 days', () => {
    const r = run([claimedBill([{ date: '2025-10-01', amount: 5_900 }])], {
      period: { year: 2026, month: 4 },
    });
    expect(r.table4.reversed.other).toEqual(t(900));
    expect(r.issues.map((i) => i.code)).toContain('rule37_interest');
  });

  it('reclaims in 4(A)(5) and 4(D)(1) when paid later', () => {
    const r = run(
      [
        doc({
          documentDate: '2025-10-01',
          payments: [
            { date: '2025-10-01', amount: 5_900 },
            { date: '2026-05-05', amount: 5_900 },
          ],
          history: { claimed: t(1_800), reversedTemporary: t(900), reclaimed: ZERO, closed: false },
        }),
      ],
      { period: { year: 2026, month: 5 } },
    );
    expect(r.table4.available.other).toEqual(t(900));
    expect(r.table4.ineligible.reclaimed_after_reversal).toEqual(t(900));
    expect(r.table4.reversed.other).toEqual(ZERO);
  });

  it('does nothing when paid within 180 days or before the 181st day', () => {
    expect(run([claimedBill([{ date: '2026-03-29', amount: 11_800 }])], {
      period: { year: 2026, month: 4 },
    }).movements).toHaveLength(0);
    // 180 days after 01.10.2025 is 30.03.2026: nothing to reverse in the February return.
    expect(run([claimedBill([])], { period: { year: 2026, month: 2 } }).movements).toHaveLength(0);
  });
});

describe('ITC engine: unfiled earlier returns', () => {
  it('does not claim again what an earlier unfiled return claims', () => {
    const bill = doc({ documentDate: '2026-03-10', twoB: { period: '2026-03', available: true, tax: t(1_800) } });
    const alone = run([bill]);
    expect(alone.table4.available.other).toEqual(t(1_800));
    const after = runItcPeriodAfter(
      {
        period: { year: 2026, month: 5 },
        documents: [bill],
        commonCapitalGoods: [],
        turnover: { exempt: 0, total: 100 },
      },
      [
        { year: 2026, month: 3 },
        { year: 2026, month: 4 },
      ],
    );
    expect(after.table4.available.other).toEqual(ZERO);
  });
});
