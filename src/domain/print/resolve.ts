/**
 * Turns a stored document into the payload a device prints.
 *
 * Pure, and the only place that decides what appears on paper. Two
 * consequences worth stating:
 *
 * - The device does no arithmetic and no formatting, so a bill reprinted from
 *   a phone's cache six months later is identical to the one handed over at
 *   the counter.
 * - The legally required strings — the document title, the composition-scheme
 *   declaration, the reverse-charge line — are decided here. Getting them
 *   wrong is a compliance problem, and it should not depend on which build of
 *   the app a till happens to be running.
 */
import type { TaxMode } from '../tax/types.js';
import {
  amountInWords,
  formatCurrency,
  formatDocumentDate,
  formatInstant,
  formatPercent,
  formatQuantity,
  upiIntent,
} from './format.js';
import type { TemplateDefinition } from './templates.js';
import type {
  PrintAmountRow,
  PrintDocument,
  PrintDocumentKind,
  PrintField,
  PrintLineItem,
  PrintTaxRow,
} from './types.js';

export interface PrintableBusiness {
  readonly name: string;
  readonly legalName: string | null;
  readonly addressLines: readonly string[];
  readonly phone: string | null;
  readonly email: string | null;
  /** The outlet's GSTIN when it has one, else the tenant's. */
  readonly gstin: string | null;
}

export interface PrintProfile {
  readonly logoObjectKey: string | null;
  readonly signatureObjectKey: string | null;
  readonly signatureLabel: string | null;
  readonly upiId: string | null;
  readonly bankLines: readonly string[];
  readonly termsLines: readonly string[];
  readonly footerLines: readonly string[];
  /** Appended to the QR when set, so a customer can look the bill up. */
  readonly lookupBaseUrl: string | null;
}

export interface PrintableCustomer {
  readonly name: string;
  readonly phone: string | null;
  readonly gstin: string | null;
  readonly addressLines: readonly string[];
  readonly stateName: string | null;
}

export interface PrintableLine {
  readonly name: string;
  /** Thousandths of a unit. */
  readonly quantity: number;
  readonly unit: string | null;
  readonly unitPrice: number;
  readonly hsnCode: string | null;
  readonly taxRatePercent: number;
  readonly discount: number;
  readonly lineTotal: number;
}

export interface PrintableTotals {
  readonly grossAmount: number;
  readonly totalDiscount: number;
  readonly taxableAmount: number;
  readonly totalCgst: number;
  readonly totalSgst: number;
  readonly totalIgst: number;
  readonly totalCess: number;
  readonly charges: number;
  readonly roundOff: number;
  readonly grandTotal: number;
  readonly amountPaid: number;
}

export interface PrintableTaxRow {
  readonly taxRatePercent: number;
  readonly taxableAmount: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
}

export interface PrintableTender {
  readonly mode: string;
  readonly amount: number;
  readonly tenderedAmount: number | null;
}

export interface ResolveInput {
  readonly kind: PrintDocumentKind;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly issuedAt: Date | string;
  readonly taxMode: TaxMode;
  readonly isInterState: boolean;
  readonly business: PrintableBusiness;
  readonly profile: PrintProfile;
  readonly customer: PrintableCustomer | null;
  readonly lines: readonly PrintableLine[];
  readonly totals: PrintableTotals;
  readonly taxRows: readonly PrintableTaxRow[];
  readonly tenders: readonly PrintableTender[];
  readonly customFields: readonly PrintField[];
  readonly template: TemplateDefinition;
  readonly timezone: string;
  readonly currencySymbol: string;
  /** Which copy this is, indexing the template's copy labels. */
  readonly copyIndex?: number;
  /** Shown on a credit note so the original can be found. */
  readonly originalDocumentNumber?: string;
  readonly cashierName?: string | null;
  readonly counterName?: string | null;
  readonly notes?: string | null;
}

const TENDER_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  wallet: 'Wallet',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
};

/**
 * The document's legal title.
 *
 * An unregistered or composition dealer may not issue a "tax invoice" — the
 * document is a bill of supply, and calling it anything else is a misstatement
 * on a legal record.
 */
function titleFor(kind: PrintDocumentKind, mode: TaxMode): string {
  if (kind === 'credit_note') return 'CREDIT NOTE';
  if (kind === 'payment_receipt') return 'RECEIPT';
  if (kind === 'estimate') return 'ESTIMATE';
  return mode === 'gst' ? 'TAX INVOICE' : 'BILL OF SUPPLY';
}

export function resolvePrintDocument(input: ResolveInput): PrintDocument {
  const money = (paise: number): string =>
    formatCurrency(paise, { symbol: input.currencySymbol });
  const template = input.template;
  const showTax = template.showTaxColumn && input.taxMode === 'gst';

  const meta: PrintField[] = [
    { label: labelForNumber(input.kind), value: input.documentNumber },
    { label: 'Date', value: formatDocumentDate(input.documentDate, input.timezone) },
    { label: 'Time', value: formatInstant(input.issuedAt, input.timezone) },
  ];
  if (input.originalDocumentNumber) {
    meta.push({ label: 'Against invoice', value: input.originalDocumentNumber });
  }
  if (input.counterName) meta.push({ label: 'Counter', value: input.counterName });
  if (input.cashierName) meta.push({ label: 'Billed by', value: input.cashierName });

  const items: PrintLineItem[] = input.lines.map((line) => ({
    name: line.name,
    quantity: formatQuantity(line.quantity),
    rate: formatCurrency(line.unitPrice),
    amount: formatCurrency(line.lineTotal),
    ...(template.showHsn && line.hsnCode ? { hsnCode: line.hsnCode } : {}),
    ...(line.unit ? { unit: line.unit } : {}),
    ...(line.discount > 0 ? { discount: formatCurrency(line.discount) } : {}),
    ...(showTax ? { taxRate: formatPercent(line.taxRatePercent) } : {}),
  }));

  const t = input.totals;
  const totals: PrintAmountRow[] = [
    { label: 'Subtotal', amount: money(t.grossAmount), paise: t.grossAmount },
  ];
  if (t.totalDiscount > 0) {
    totals.push({
      label: 'Discount',
      amount: `-${money(t.totalDiscount)}`,
      paise: t.totalDiscount,
    });
  }
  if (t.charges > 0) {
    totals.push({ label: 'Other charges', amount: money(t.charges), paise: t.charges });
  }
  if (input.taxMode === 'gst') {
    // Intra-state bills print the two halves separately because that is what
    // a customer's own accountant needs to see; inter-state prints IGST.
    if (input.isInterState) {
      totals.push({ label: 'IGST', amount: money(t.totalIgst), paise: t.totalIgst });
    } else {
      totals.push({ label: 'CGST', amount: money(t.totalCgst), paise: t.totalCgst });
      totals.push({ label: 'SGST', amount: money(t.totalSgst), paise: t.totalSgst });
    }
    if (t.totalCess > 0) {
      totals.push({ label: 'Cess', amount: money(t.totalCess), paise: t.totalCess });
    }
  }
  if (t.roundOff !== 0) {
    totals.push({
      label: 'Round off',
      amount: formatCurrency(t.roundOff, { symbol: input.currencySymbol }),
      paise: t.roundOff,
    });
  }
  totals.push({
    label: 'TOTAL',
    amount: money(t.grandTotal),
    emphasis: true,
    paise: t.grandTotal,
  });

  const tenders: PrintAmountRow[] = input.tenders.map((tender) => ({
    label: TENDER_LABELS[tender.mode] ?? tender.mode,
    amount: money(tender.amount),
    paise: tender.amount,
  }));
  // Change due is the number a cashier and a customer both look for, so it is
  // computed here rather than left to the renderer.
  const cash = input.tenders.find((x) => x.mode === 'cash' && x.tenderedAmount != null);
  if (cash?.tenderedAmount != null && cash.tenderedAmount > cash.amount) {
    tenders.push({
      label: 'Tendered',
      amount: money(cash.tenderedAmount),
      paise: cash.tenderedAmount,
    });
    tenders.push({
      label: 'Change due',
      amount: money(cash.tenderedAmount - cash.amount),
      emphasis: true,
      paise: cash.tenderedAmount - cash.amount,
    });
  }
  const outstanding = t.grandTotal - t.amountPaid;
  if (outstanding > 0) {
    tenders.push({
      label: input.kind === 'credit_note' ? 'Credited to khata' : 'Balance on khata',
      amount: money(outstanding),
      emphasis: true,
      paise: outstanding,
    });
  }

  const taxRows: PrintTaxRow[] =
    template.showTaxSummary && input.taxMode === 'gst'
      ? input.taxRows.map((row) => ({
          rate: formatPercent(row.taxRatePercent),
          taxable: formatCurrency(row.taxableAmount),
          ...(row.cgst > 0 ? { cgst: formatCurrency(row.cgst) } : {}),
          ...(row.sgst > 0 ? { sgst: formatCurrency(row.sgst) } : {}),
          ...(row.igst > 0 ? { igst: formatCurrency(row.igst) } : {}),
          ...(row.cess > 0 ? { cess: formatCurrency(row.cess) } : {}),
        }))
      : [];

  const termsLines: string[] = [...input.profile.termsLines];
  // Section 10(5) of the CGST Act: a composition dealer must say this on every
  // bill of supply, in these words.
  if (input.taxMode === 'composition') {
    termsLines.unshift(
      'Composition taxable person, not eligible to collect tax on supplies.',
    );
  }
  if (input.notes) termsLines.push(input.notes);
  if (input.profile.bankLines.length > 0) termsLines.push(...input.profile.bankLines);

  const copyLabel = template.copyLabels[input.copyIndex ?? 0];

  return {
    kind: input.kind,
    title: titleFor(input.kind, input.taxMode),
    business: {
      name: input.business.name,
      addressLines: input.business.addressLines,
      ...(input.business.phone ? { phone: input.business.phone } : {}),
      ...(input.business.gstin ? { gstin: input.business.gstin } : {}),
      ...(input.business.email ? { email: input.business.email } : {}),
      ...(input.profile.logoObjectKey
        ? { logoObjectKey: input.profile.logoObjectKey }
        : {}),
      ...(input.profile.upiId ? { upiId: input.profile.upiId } : {}),
      bankLines: input.profile.bankLines,
    },
    ...(template.showCustomerBlock && input.customer
      ? {
          customer: {
            name: input.customer.name,
            ...(input.customer.phone ? { phone: input.customer.phone } : {}),
            ...(input.customer.gstin ? { gstin: input.customer.gstin } : {}),
            addressLines: input.customer.addressLines,
            ...(input.customer.stateName ? { stateName: input.customer.stateName } : {}),
          },
        }
      : {}),
    meta,
    items,
    totals,
    taxRows,
    tenders,
    customFields: input.customFields,
    ...(template.showAmountInWords
      ? { amountInWords: amountInWords(t.grandTotal) }
      : {}),
    ...resolveQr(input, outstanding),
    footerLines: input.profile.footerLines,
    termsLines,
    ...(template.showSignature && input.profile.signatureLabel
      ? { signatureLabel: input.profile.signatureLabel }
      : {}),
    ...(copyLabel ? { copyLabel } : {}),
    showHsn: template.showHsn,
    showTaxColumn: showTax,
  };
}

function labelForNumber(kind: PrintDocumentKind): string {
  switch (kind) {
    case 'credit_note':
      return 'Credit note no.';
    case 'payment_receipt':
      return 'Receipt no.';
    case 'estimate':
      return 'Estimate no.';
    default:
      return 'Invoice no.';
  }
}

/**
 * A UPI collect QR when money is still owed and the shop has a VPA; otherwise
 * a lookup link if one is configured. Printing a payment QR on a fully paid
 * bill invites a second payment, so it is deliberately conditional.
 */
function resolveQr(
  input: ResolveInput,
  outstanding: number,
): { qrPayload?: string; qrCaption?: string } {
  if (
    input.kind === 'invoice' &&
    outstanding > 0 &&
    input.profile.upiId &&
    input.business.name
  ) {
    return {
      qrPayload: upiIntent({
        vpa: input.profile.upiId,
        payeeName: input.business.name,
        amountPaise: outstanding,
        reference: input.documentNumber,
        note: `Bill ${input.documentNumber}`,
      }),
      qrCaption: `Scan to pay ${formatCurrency(outstanding, { symbol: input.currencySymbol })}`,
    };
  }

  const base = input.profile.lookupBaseUrl?.trim();
  if (base) {
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
    return {
      qrPayload: `${trimmed}/${encodeURIComponent(input.documentNumber)}`,
      qrCaption: 'Scan for a digital copy',
    };
  }
  return {};
}
