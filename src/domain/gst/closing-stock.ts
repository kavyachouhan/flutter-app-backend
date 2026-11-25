/**
 * Input tax credit on stock and capital goods held on a date (Rule 44), for:
 *   - GSTR-10 Table 8 (final return after cancellation, s.29(5), s.45, Rule 81),
 *   - REG-16 Table 10 (from 01.12.2026, Rule 44(4) as amended by 05/2026-CT),
 *   - ITC-03 (switch to composition or to wholly exempt supplies, s.18(4)).
 * Pure.
 *
 *   Rule 44(1)(a): inputs held in stock and contained in semi-finished or finished goods, ITC
 *     "proportionately on the basis of the corresponding invoices". The stock is matched to the
 *     latest purchases first (what is left on the shelf is what came in last).
 *   Rule 44(1)(b): capital goods, the ITC for the remaining useful life in months on a five-year
 *     life, ignoring part of a month (the rule's illustration: 4 years 6 months 15 days used, 5
 *     months remain, C x 5/60).
 *   Rule 44(3) and (5): stock without invoices is estimated at the prevailing market price and
 *     certified by a chartered or cost accountant. Such stock is listed, not valued, here.
 *   s.29(5): the amount payable is the higher of this ITC and the output tax on the goods. The
 *     output tax is not worked out here.
 */
import type { TaxAmounts } from './returns/model.js';

export interface StockHolding {
  readonly itemId: string;
  readonly itemName: string;
  readonly hsn: string | null;
  /** Thousandths of a unit. */
  readonly quantity: number;
}

export interface PurchaseLot {
  readonly itemId: string;
  readonly billNumber: string;
  readonly supplierGstin: string | null;
  readonly date: string;
  /** Thousandths of a unit. */
  readonly quantity: number;
  readonly tax: TaxAmounts;
}

export interface CapitalGood {
  readonly registerId: string;
  readonly billNumber: string;
  readonly supplierGstin: string | null;
  readonly date: string;
  readonly tax: TaxAmounts;
}

export interface StockItcRow {
  readonly itemId: string;
  readonly itemName: string;
  readonly hsn: string | null;
  readonly quantity: number;
  readonly matchedQuantity: number;
  readonly invoices: readonly string[];
  readonly tax: TaxAmounts;
}

export interface CapitalGoodRow {
  readonly billNumber: string;
  readonly supplierGstin: string | null;
  readonly date: string;
  readonly remainingMonths: number;
  readonly tax: TaxAmounts;
}

export interface ClosingStockItc {
  readonly asOf: string;
  readonly inputs: readonly StockItcRow[];
  /** Stock (or part of it) with no purchase invoice on file: Rule 44(3), valued by a CA/CMA. */
  readonly withoutInvoices: readonly { itemId: string; itemName: string; hsn: string | null; quantity: number }[];
  readonly capitalGoods: readonly CapitalGoodRow[];
  readonly total: TaxAmounts;
}

const ZERO: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
const add = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => ({
  igst: a.igst + b.igst,
  cgst: a.cgst + b.cgst,
  sgst: a.sgst + b.sgst,
  cess: a.cess + b.cess,
});
const scale = (a: TaxAmounts, k: number): TaxAmounts => ({
  igst: Math.round(a.igst * k),
  cgst: Math.round(a.cgst * k),
  sgst: Math.round(a.sgst * k),
  cess: Math.round(a.cess * k),
});

/** Whole months of useful life left (60 less the months used, part of a month ignored). */
export function remainingMonths(invoiceDate: string, asOf: string): number {
  const [y1, m1, d1] = invoiceDate.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = asOf.split('-').map(Number) as [number, number, number];
  let used = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) used -= 1; // the current month is not complete
  const usedFraction = used + (d2 >= d1 ? (d2 - d1) / 31 : (d2 + 31 - d1) / 31);
  return Math.max(0, Math.min(60, Math.floor(60 - usedFraction)));
}

export function closingStockItc(
  asOf: string,
  holdings: readonly StockHolding[],
  lots: readonly PurchaseLot[],
  capitalGoods: readonly CapitalGood[],
): ClosingStockItc {
  const byItem = new Map<string, PurchaseLot[]>();
  for (const l of lots) {
    if (l.date > asOf || l.quantity <= 0) continue;
    byItem.set(l.itemId, [...(byItem.get(l.itemId) ?? []), l]);
  }
  const inputs: StockItcRow[] = [];
  const withoutInvoices: ClosingStockItc['withoutInvoices'][number][] = [];
  for (const h of holdings) {
    if (h.quantity <= 0) continue;
    const list = (byItem.get(h.itemId) ?? []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    let left = h.quantity;
    let tax = ZERO;
    const invoices: string[] = [];
    for (const lot of list) {
      if (left <= 0) break;
      const take = Math.min(left, lot.quantity);
      tax = add(tax, scale(lot.tax, take / lot.quantity));
      invoices.push(lot.billNumber);
      left -= take;
    }
    if (invoices.length > 0) {
      inputs.push({ ...h, matchedQuantity: h.quantity - left, invoices, tax });
    }
    if (left > 0) withoutInvoices.push({ itemId: h.itemId, itemName: h.itemName, hsn: h.hsn, quantity: left });
  }
  const capital: CapitalGoodRow[] = capitalGoods
    .filter((c) => c.date <= asOf)
    .map((c) => {
      const months = remainingMonths(c.date, asOf);
      return { billNumber: c.billNumber, supplierGstin: c.supplierGstin, date: c.date, remainingMonths: months, tax: scale(c.tax, months / 60) };
    })
    .filter((c) => c.remainingMonths > 0);
  const total = [...inputs.map((i) => i.tax), ...capital.map((c) => c.tax)].reduce(add, ZERO);
  return { asOf, inputs, withoutInvoices, capitalGoods: capital, total };
}
