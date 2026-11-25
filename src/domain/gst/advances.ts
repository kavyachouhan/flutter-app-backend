/**
 * Advances under GST (Table 11 of GSTR-1). Pure.
 *
 *   - Receipt voucher (s.31(3)(d), Rule 50): tax on an advance for services is due when the advance
 *     is received (s.13(2)); the amount received is tax-inclusive. Where the rate cannot be
 *     determined, 18%; where the nature of supply cannot be determined, inter-State (Rule 50
 *     proviso). For goods, a regular taxpayer pays at the invoice, not the advance (66/2017-CT;
 *     actionable claims excluded by 50/2023), so a goods voucher carries no tax.
 *   - 11A: advances received in the period and not invoiced in the same period, net of refund
 *     vouchers (26/2022 instruction to 11(I)A). 11B: advances of an earlier period adjusted
 *     against invoices of this period. Both by place of supply and rate (GSTR-1 manual; Offline
 *     Tool at.csv / atadj.csv). A refund of an earlier period's advance is shown with 11B, with a
 *     note, since the tax on it was paid in that earlier period.
 */
import type { TaxedValue } from './returns/model.js';

export const RULE_50_DEFAULT_RATE = 18;

export function voucherTax(args: {
  amount: number;
  ratePercent: number;
  supplyKind: 'goods' | 'services';
  supplyType: 'intra_state' | 'inter_state';
}): TaxedValue {
  if (args.supplyKind === 'goods' || args.ratePercent === 0) {
    return { taxable: args.amount, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  }
  const taxable = Math.round((args.amount * 100) / (100 + args.ratePercent));
  const tax = args.amount - taxable;
  if (args.supplyType === 'inter_state') return { taxable, igst: tax, cgst: 0, sgst: 0, cess: 0 };
  const half = Math.floor(tax / 2);
  return { taxable, igst: 0, cgst: tax - half, sgst: half, cess: 0 };
}

/** The share of a voucher's value and tax for part of its amount (adjustment or refund). */
export function shareOf(voucher: { amount: number; value: TaxedValue }, part: number): TaxedValue {
  if (part >= voucher.amount) return voucher.value;
  const k = part / voucher.amount;
  const v = voucher.value;
  const taxable = Math.round(v.taxable * k);
  const igst = Math.round(v.igst * k);
  const cgst = Math.round(v.cgst * k);
  const sgst = Math.round(v.sgst * k);
  return { taxable, igst, cgst, sgst, cess: Math.round(v.cess * k) };
}

export interface AdvanceVoucher {
  readonly id: string;
  readonly period: string; // YYYY-MM of the voucher date
  readonly placeOfSupply: string;
  readonly supplyType: 'intra_state' | 'inter_state';
  readonly ratePercent: number;
  readonly supplyKind: 'goods' | 'services';
  readonly value: TaxedValue;
}

export interface AdvanceMovement {
  readonly voucherId: string;
  readonly period: string; // YYYY-MM of the invoice (adjustment) or refund voucher
  readonly value: TaxedValue;
}

export interface Table11Row {
  readonly placeOfSupply: string;
  readonly supplyType: 'intra_state' | 'inter_state';
  readonly ratePercent: number;
  readonly value: TaxedValue;
}

export interface Table11 {
  /** 11A: received, not invoiced in the same period, net of refunds. */
  readonly received: readonly Table11Row[];
  /** 11B: earlier advances adjusted against this period's invoices (and refunded). */
  readonly adjusted: readonly Table11Row[];
  readonly refundsOfEarlierAdvances: number;
}

const ZERO: TaxedValue = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
const add = (a: TaxedValue, b: TaxedValue, k = 1): TaxedValue => ({
  taxable: a.taxable + k * b.taxable,
  igst: a.igst + k * b.igst,
  cgst: a.cgst + k * b.cgst,
  sgst: a.sgst + k * b.sgst,
  cess: a.cess + k * b.cess,
});
const isZero = (v: TaxedValue) => v.taxable === 0 && v.igst === 0 && v.cgst === 0 && v.sgst === 0 && v.cess === 0;

/** Table 11 for `period`. Only vouchers that carry tax (services) are reported. */
export function buildTable11(
  period: string,
  vouchers: readonly AdvanceVoucher[],
  adjustments: readonly AdvanceMovement[],
  refunds: readonly AdvanceMovement[],
): Table11 {
  const taxed = new Map(vouchers.filter((v) => v.supplyKind === 'services').map((v) => [v.id, v]));
  const received = new Map<string, Table11Row>();
  const adjusted = new Map<string, Table11Row>();
  const bump = (m: Map<string, Table11Row>, v: AdvanceVoucher, value: TaxedValue, k: number) => {
    const key = `${v.placeOfSupply}|${v.ratePercent}|${v.supplyType}`;
    const cur = m.get(key);
    m.set(key, {
      placeOfSupply: v.placeOfSupply,
      supplyType: v.supplyType,
      ratePercent: v.ratePercent,
      value: add(cur?.value ?? ZERO, value, k),
    });
  };
  for (const v of taxed.values()) if (v.period === period) bump(received, v, v.value, 1);
  let refundsOfEarlierAdvances = 0;
  for (const list of [adjustments, refunds]) {
    for (const m of list) {
      if (m.period !== period) continue;
      const v = taxed.get(m.voucherId);
      if (!v) continue;
      if (v.period === period) bump(received, v, m.value, -1);
      else {
        bump(adjusted, v, m.value, 1);
        if (list === refunds) refundsOfEarlierAdvances += 1;
      }
    }
  }
  const rows = (m: Map<string, Table11Row>) => [...m.values()].filter((r) => !isZero(r.value));
  return { received: rows(received), adjusted: rows(adjusted), refundsOfEarlierAdvances };
}

export const table11Total = (rows: readonly Table11Row[]): TaxedValue =>
  rows.reduce((s, r) => add(s, r.value), ZERO);
