/**
 * Time of supply (D32, freeze §4.4): which date a document's GST is due on, and so which rates
 * apply to it. Shared with the Flutter app (`packages/khata_domain/lib/src/gst/time_of_supply.dart`).
 *
 * The date comes from what happened, never from the document date alone. Each statutory rule is
 * one small function, and the day limits and rate-change dates come from the dated rule set, so a
 * change in law is a data change or one rule here.
 *
 *   CGST s.12(2)  goods: invoice date, or the s.31(1) due date if earlier. Advances on goods are
 *                 not taxed (Notif. 66/2017-CT), so a payment does not move it.
 *   CGST s.13(2)  services: invoice in time → earlier of invoice and payment; late → earlier of
 *                 service completion and payment.
 *   CGST s.12(3)  reverse charge, goods: earliest of receipt, payment and a set number of days
 *                 after the supplier's invoice; else the date of entry in the recipient's books.
 *   CGST s.13(3)  reverse charge, services: earlier of payment and a set number of days after the
 *                 supplier's invoice; else the date of entry in the recipient's books.
 *   CGST s.14     a rate change falling between the events overrides the above.
 *
 * Ordinary purchases do not come here: the supplier determined that date (freeze §4.4a).
 */
import { ValidationError } from '../../lib/errors.js';
import type { TaxPointProvision } from './enums.js';
import { thresholdValue, type GstRuleSet, type IsoDate } from './rule-set.js';

export interface TaxPointFacts {
  /** The document's own date; for reverse charge, the date of entry in the recipient's books. */
  readonly invoiceDate: IsoDate;
  readonly removalDate?: IsoDate | null;
  readonly deliveryDate?: IsoDate | null;
  readonly paymentDate?: IsoDate | null;
  /** s.31 due date when known outright; otherwise derived from the facts above. */
  readonly invoiceDueDate?: IsoDate | null;
  readonly serviceCompletionDate?: IsoDate | null;
  readonly supplierInvoiceDate?: IsoDate | null;
  readonly receiptDate?: IsoDate | null;
  readonly boeDate?: IsoDate | null;
}

export type TaxPointKind = 'outward_goods' | 'outward_services' | 'inward_rcm_goods' | 'inward_rcm_services';

export interface TaxPoint {
  readonly date: IsoDate;
  readonly provision: TaxPointProvision;
}

function earliest(...dates: (IsoDate | null | undefined)[]): IsoDate | null {
  let best: IsoDate | null = null;
  for (const d of dates) {
    if (d !== null && d !== undefined && (best === null || d < best)) best = d;
  }
  return best;
}

/** Calendar arithmetic on an ISO date, in UTC so a device's time zone cannot move it. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Dates on which any rate changed, from the entries of the given rule set. Every version is a
 * complete snapshot carrying its history, so the latest version knows them all.
 */
export function rateChangeDates(ruleSet: GstRuleSet): readonly IsoDate[] {
  const starts = [...ruleSet.content.taxRates, ...ruleSet.content.allowedRates].map((e) => e.effectiveFrom);
  const distinct = [...new Set(starts)].sort();
  // The earliest start is when the rates began, not a change to them.
  return distinct.slice(1);
}

function outwardGoods(facts: TaxPointFacts): TaxPoint {
  // s.31(1): the invoice is due by removal when goods move, else by delivery.
  const due = facts.invoiceDueDate ?? facts.removalDate ?? facts.deliveryDate;
  return { date: earliest(facts.invoiceDate, due) ?? facts.invoiceDate, provision: 'cgst_12_2' };
}

function outwardServices(facts: TaxPointFacts, ruleSet: GstRuleSet): TaxPoint {
  const due =
    facts.invoiceDueDate ??
    (facts.serviceCompletionDate
      ? addDays(facts.serviceCompletionDate, thresholdValue(ruleSet, 'tos_service_invoice_days', facts.invoiceDate))
      : null);
  const late = due !== null && facts.invoiceDate > due;
  const date = late
    ? earliest(facts.serviceCompletionDate, facts.paymentDate)
    : earliest(facts.invoiceDate, facts.paymentDate);
  return { date: date ?? facts.invoiceDate, provision: 'cgst_13_2' };
}

function inwardRcmGoods(facts: TaxPointFacts, ruleSet: GstRuleSet): TaxPoint {
  const deemed = facts.supplierInvoiceDate
    ? addDays(facts.supplierInvoiceDate, thresholdValue(ruleSet, 'tos_rcm_goods_days', facts.supplierInvoiceDate))
    : null;
  return { date: earliest(facts.receiptDate, facts.paymentDate, deemed) ?? facts.invoiceDate, provision: 'cgst_12_3' };
}

function inwardRcmServices(facts: TaxPointFacts, ruleSet: GstRuleSet): TaxPoint {
  const deemed = facts.supplierInvoiceDate
    ? addDays(facts.supplierInvoiceDate, thresholdValue(ruleSet, 'tos_rcm_services_days', facts.supplierInvoiceDate))
    : null;
  return { date: earliest(facts.paymentDate, deemed) ?? facts.invoiceDate, provision: 'cgst_13_3' };
}

/**
 * s.14: with a rate change between the events, the date depends on which events fell on which
 * side of it. Null means s.14 does not apply. A payment not yet made falls after the change; if
 * s.14 then points at that payment, the supply date stands in, which is on the same side.
 */
function rateChange(facts: TaxPointFacts, changes: readonly IsoDate[]): TaxPoint | null {
  const supply = facts.removalDate ?? facts.deliveryDate ?? facts.serviceCompletionDate ?? facts.receiptDate;
  if (!supply) return null;
  const invoice = facts.supplierInvoiceDate ?? facts.invoiceDate;
  const payment = facts.paymentDate ?? null;
  const events = [supply, invoice, ...(payment ? [payment] : [])].sort();
  const change = changes.find((c) => (events[0] as string) < c && c <= (events[events.length - 1] as string));
  if (change === undefined) {
    // Unpaid, with supply and invoice both before a later change: nothing has crossed it yet.
    return null;
  }

  const after = (d: IsoDate): boolean => d >= change;
  const invoiceAfter = after(invoice);
  const paymentAfter = payment === null || after(payment);
  const earlierOfBoth = payment !== null && payment < invoice ? payment : invoice;
  let date: IsoDate;
  if (!after(supply)) {
    // s.14(a): supplied before the change.
    if (invoiceAfter && paymentAfter) date = earlierOfBoth;
    else if (paymentAfter) date = invoice;
    else date = payment;
  } else {
    // s.14(b): supplied after the change.
    if (!invoiceAfter && !paymentAfter) date = earlierOfBoth;
    else if (paymentAfter) date = payment ?? supply;
    else date = invoice;
  }
  return { date, provision: 'cgst_14' };
}

/**
 * The tax point of a document. `ruleSet` supplies the day limits and rate-change dates: pass the
 * latest published version, which carries the history of every rate. The date this returns is
 * then what selects the version whose rates apply (`selectRuleSet`).
 */
export function resolveTaxPoint(facts: TaxPointFacts, kind: TaxPointKind, ruleSet: GstRuleSet): TaxPoint {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(facts.invoiceDate)) {
    throw new ValidationError('A tax point needs the document date.', { details: { kind } });
  }
  const statutory = (): TaxPoint => {
    switch (kind) {
      case 'outward_goods':
        return outwardGoods(facts);
      case 'outward_services':
        return outwardServices(facts, ruleSet);
      case 'inward_rcm_goods':
        return inwardRcmGoods(facts, ruleSet);
      case 'inward_rcm_services':
        return inwardRcmServices(facts, ruleSet);
    }
  };
  return rateChange(facts, rateChangeDates(ruleSet)) ?? statutory();
}

/** The tax point for an ordinary purchase: the supplier's, recorded as reported (freeze §4.4a). */
export function supplierReportedTaxPoint(supplierInvoiceDate: IsoDate): TaxPoint {
  return { date: supplierInvoiceDate, provision: 'supplier_reported' };
}
