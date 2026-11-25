import { describe, expect, it } from 'vitest';
import { buildTable11, shareOf, voucherTax, type AdvanceVoucher } from './advances.js';

describe('receipt voucher tax (Rule 50)', () => {
  it('backs tax out of a services advance, split intra-state', () => {
    expect(voucherTax({ amount: 11_800, ratePercent: 18, supplyKind: 'services', supplyType: 'intra_state' })).toEqual({
      taxable: 10_000, igst: 0, cgst: 900, sgst: 900, cess: 0,
    });
  });
  it('charges no tax on a goods advance (66/2017-CT)', () => {
    expect(voucherTax({ amount: 11_800, ratePercent: 18, supplyKind: 'goods', supplyType: 'inter_state' }).igst).toBe(0);
  });
  it('shares value pro rata for a part adjustment', () => {
    const v = { amount: 11_800, value: { taxable: 10_000, igst: 1_800, cgst: 0, sgst: 0, cess: 0 } };
    expect(shareOf(v, 5_900)).toEqual({ taxable: 5_000, igst: 900, cgst: 0, sgst: 0, cess: 0 });
  });
});

describe('table 11', () => {
  const v = (id: string, period: string, kind: 'goods' | 'services' = 'services'): AdvanceVoucher => ({
    id, period, placeOfSupply: '27', supplyType: 'intra_state', ratePercent: 18, supplyKind: kind,
    value: { taxable: 10_000, igst: 0, cgst: 900, sgst: 900, cess: 0 },
  });
  const half = { taxable: 5_000, igst: 0, cgst: 450, sgst: 450, cess: 0 };

  it('reports this period advances in 11A, net of what is invoiced or refunded in the period', () => {
    const t = buildTable11('2026-11', [v('a', '2026-11')], [{ voucherId: 'a', period: '2026-11', value: half }], []);
    expect(t.received[0]?.value.taxable).toBe(5_000);
    expect(t.adjusted).toHaveLength(0);
  });
  it('reports earlier advances invoiced now in 11B', () => {
    const t = buildTable11('2026-12', [v('a', '2026-11')], [{ voucherId: 'a', period: '2026-12', value: half }], []);
    expect(t.received).toHaveLength(0);
    expect(t.adjusted[0]?.value.cgst).toBe(450);
  });
  it('leaves goods advances out', () => {
    expect(buildTable11('2026-11', [v('g', '2026-11', 'goods')], [], []).received).toHaveLength(0);
  });
});
