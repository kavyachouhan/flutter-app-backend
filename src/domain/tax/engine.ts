/**
 * The GST tax engine.
 *
 * A pure function: same input, same output, no clock, no database, no
 * randomness. That is a hard requirement, not a style preference — the Dart
 * port in the Flutter app must produce byte-identical results so a device can
 * bill offline and have the server agree on sync.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF OPERATIONS  (changing this changes every total in the system)
 * ---------------------------------------------------------------------------
 *   1. Line gross          = unitPrice × quantity
 *   2. Line discount       applied to the line
 *   3. Bill discount       apportioned across lines by post-line-discount
 *                          value, using largest-remainder so the parts sum
 *                          exactly to the discount
 *   4. Tax back-out        if prices include tax:
 *                              taxable = inclusive × 100 / (100 + rate + cess)
 *   5. Tax                 per line, on the taxable amount
 *   6. CGST/SGST split     intra-state only; halves that sum exactly
 *   7. Charges             taxable ones join the tax computation
 *   8. Round-off           to the nearest rupee, reported separately
 *
 * ---------------------------------------------------------------------------
 * ROUNDING
 * ---------------------------------------------------------------------------
 * Half away from zero, applied ONCE per line, and totals are summed from the
 * rounded line values. Rounding the total independently of the lines is the
 * classic invoice bug: the printed lines then do not add up to the printed
 * total, and a customer who checks will find it.
 */
import {
  distribute,
  lineAmount,
  percentOf,
  roundHalfAwayFromZero,
  roundToNearestRupee,
  sum,
} from '../../lib/money.js';
import { ValidationError } from '../../lib/errors.js';
import type {
  AdditionalCharge,
  Discount,
  HsnSummary,
  SupplyType,
  TaxInvoiceInput,
  TaxInvoiceResult,
  TaxLineInput,
  TaxLineResult,
  TaxRateSummary,
} from './types.js';

/**
 * The GST rates in force. Validated rather than free-form: a typo turning 18
 * into 1.8 is a filing error that surfaces months later at reconciliation.
 */
const VALID_GST_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28]);

/**
 * Resolves a discount to a paise amount, clamped to the base.
 *
 * Clamping matters: a ₹500 discount on a ₹300 line must not produce a
 * negative taxable value, which would turn into negative tax and a credit the
 * business never intended to give.
 */
function resolveDiscount(discount: Discount | undefined, base: number): number {
  if (!discount) return 0;

  const amount =
    discount.kind === 'percent' ? percentOf(base, discount.value) : Math.trunc(discount.value);

  if (amount < 0) {
    throw new ValidationError('A discount cannot be negative.', {
      details: { discount },
    });
  }

  return Math.min(amount, base);
}

/** Intra-state when the customer is in the supplier's state, or unknown. */
export function resolveSupplyType(
  supplierStateCode: string,
  placeOfSupplyStateCode: string | undefined,
): SupplyType {
  // A walk-in cash sale has no recorded customer state. Over-the-counter
  // retail is intra-state by definition — the goods change hands in the shop.
  if (!placeOfSupplyStateCode) return 'intra_state';
  return placeOfSupplyStateCode === supplierStateCode ? 'intra_state' : 'inter_state';
}

/**
 * Splits a tax amount into CGST and SGST halves that sum to it exactly.
 *
 * On an odd number of paise the extra goes to CGST. The convention matters
 * less than its consistency: the same rule must hold on the client, on the
 * server, and on the credit note that reverses the invoice.
 */
function splitCgstSgst(tax: number): { cgst: number; sgst: number } {
  const cgst = roundHalfAwayFromZero(tax / 2);
  return { cgst, sgst: tax - cgst };
}

/**
 * Backs tax out of a tax-inclusive amount.
 *
 *   taxable = inclusive × 100 / (100 + rate + cess)
 *
 * MRP-based retail quotes one inclusive price, so this is the common path in
 * Indian shops, not an edge case.
 */
function extractTaxableFromInclusive(
  inclusive: number,
  taxRatePercent: number,
  cessRatePercent: number,
): number {
  const totalRate = taxRatePercent + cessRatePercent;
  if (totalRate === 0) return inclusive;
  return roundHalfAwayFromZero((inclusive * 100) / (100 + totalRate));
}

function validateInput(input: TaxInvoiceInput): void {
  if (input.lines.length === 0) {
    throw new ValidationError('An invoice must have at least one line.');
  }

  if (!/^[0-9]{2}$/.test(input.supplierStateCode)) {
    throw new ValidationError('The supplier state code must be two digits.', {
      details: { supplierStateCode: input.supplierStateCode },
    });
  }

  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError('Quantity must be a positive whole number of thousandths.', {
        details: { lineId: line.id, quantity: line.quantity },
      });
    }

    if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) {
      throw new ValidationError('Unit price must be a non-negative whole number of paise.', {
        details: { lineId: line.id, unitPrice: line.unitPrice },
      });
    }

    // Only checked in GST mode: an unregistered shop stores 0 everywhere, and
    // a composition dealer records the notional rate without charging it.
    if (input.mode === 'gst' && !VALID_GST_RATES.has(line.taxRatePercent)) {
      throw new ValidationError(
        `${line.taxRatePercent}% is not a valid GST rate. ` +
          `Valid rates: ${[...VALID_GST_RATES].join(', ')}.`,
        { details: { lineId: line.id, taxRatePercent: line.taxRatePercent } },
      );
    }
  }
}

/**
 * Computes every total for one invoice.
 *
 * @throws ValidationError when the input is structurally impossible. Business
 *         rules that depend on stored state (credit limits, stock on hand) are
 *         checked by the service layer, not here — this function stays pure.
 */
export function computeInvoice(input: TaxInvoiceInput): TaxInvoiceResult {
  validateInput(input);

  const supplyType = resolveSupplyType(input.supplierStateCode, input.placeOfSupplyStateCode);

  // Neither an unregistered shop nor a composition dealer charges tax. Rates
  // are still carried through to the output so the stored document keeps the
  // item's notional rate for later registration or reporting.
  const taxesApply = input.mode === 'gst';

  // --- Steps 1-2: line gross and line discounts ----------------------------
  const grossAmounts = input.lines.map((line) => lineAmount(line.unitPrice, line.quantity));
  const lineDiscounts = input.lines.map((line, index) =>
    resolveDiscount(line.discount, grossAmounts[index] ?? 0),
  );
  const afterLineDiscount = grossAmounts.map((gross, index) => gross - (lineDiscounts[index] ?? 0));

  // --- Step 3: apportion the bill-level discount ---------------------------
  // Weighted by post-line-discount value, so a line already discounted to zero
  // absorbs none of it. Largest-remainder distribution guarantees the shares
  // sum to the discount exactly — a naive per-line percentage would lose or
  // gain paise and leave the printed lines not adding up to the printed total.
  const billDiscountTotal = resolveDiscount(input.billDiscount, sum(afterLineDiscount));
  const billDiscountShares = distribute(billDiscountTotal, afterLineDiscount);

  const netAmounts = afterLineDiscount.map(
    (amount, index) => amount - (billDiscountShares[index] ?? 0),
  );

  // --- Steps 4-6: taxable value and tax per line ---------------------------
  const lines: TaxLineResult[] = input.lines.map((line, index) => {
    const net = netAmounts[index] ?? 0;
    const cessRate = taxesApply ? (line.cessRatePercent ?? 0) : 0;
    const taxRate = taxesApply ? line.taxRatePercent : 0;

    const taxableAmount = input.pricesIncludeTax
      ? extractTaxableFromInclusive(net, taxRate, cessRate)
      : net;

    const tax = taxesApply ? percentOf(taxableAmount, taxRate) : 0;
    const cess = taxesApply ? percentOf(taxableAmount, cessRate) : 0;

    const { cgst, sgst } = supplyType === 'intra_state' ? splitCgstSgst(tax) : { cgst: 0, sgst: 0 };
    const igst = supplyType === 'inter_state' ? tax : 0;

    return {
      id: line.id,
      grossAmount: grossAmounts[index] ?? 0,
      lineDiscount: lineDiscounts[index] ?? 0,
      apportionedBillDiscount: billDiscountShares[index] ?? 0,
      taxableAmount,
      taxRatePercent: line.taxRatePercent,
      cgst,
      sgst,
      igst,
      cess,
      lineTotal: taxableAmount + cgst + sgst + igst + cess,
      hsnCode: line.hsnCode,
    };
  });

  // --- Step 7: additional charges ------------------------------------------
  const charges = input.additionalCharges ?? [];
  const chargeResults = charges.map((charge) => computeCharge(charge, supplyType, taxesApply));

  const taxableCharges = sum(chargeResults.filter((c) => c.taxable).map((c) => c.taxableAmount));
  const nonTaxableCharges = sum(
    chargeResults.filter((c) => !c.taxable).map((c) => c.taxableAmount),
  );

  // --- Totals --------------------------------------------------------------
  const totalCgst = sum([...lines.map((l) => l.cgst), ...chargeResults.map((c) => c.cgst)]);
  const totalSgst = sum([...lines.map((l) => l.sgst), ...chargeResults.map((c) => c.sgst)]);
  const totalIgst = sum([...lines.map((l) => l.igst), ...chargeResults.map((c) => c.igst)]);
  const totalCess = sum([...lines.map((l) => l.cess), ...chargeResults.map((c) => c.cess)]);

  const lineTaxableTotal = sum(lines.map((l) => l.taxableAmount));
  const taxableAmount = lineTaxableTotal + taxableCharges;
  const totalTax = totalCgst + totalSgst + totalIgst + totalCess;

  const subTotal = taxableAmount + totalTax + nonTaxableCharges;

  const { rounded, adjustment } = input.roundOff
    ? roundToNearestRupee(subTotal)
    : { rounded: subTotal, adjustment: 0 };

  return {
    supplyType,
    mode: input.mode,
    lines,

    grossAmount: sum(grossAmounts),
    totalLineDiscount: sum(lineDiscounts),
    billDiscount: billDiscountTotal,
    totalDiscount: sum(lineDiscounts) + billDiscountTotal,

    taxableAmount,
    totalCgst,
    totalSgst,
    totalIgst,
    totalCess,
    totalTax,

    taxableCharges,
    nonTaxableCharges,

    subTotal,
    roundOff: adjustment,
    grandTotal: rounded,

    taxSummary: buildTaxSummary(lines, chargeResults),
    hsnSummary: buildHsnSummary(input.lines, lines),
  };
}

// ---------------------------------------------------------------------------
// Additional charges
// ---------------------------------------------------------------------------

interface ChargeResult {
  taxable: boolean;
  taxRatePercent: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

function computeCharge(
  charge: AdditionalCharge,
  supplyType: SupplyType,
  taxesApply: boolean,
): ChargeResult {
  if (!charge.taxable || !taxesApply) {
    return {
      taxable: false,
      taxRatePercent: 0,
      taxableAmount: charge.amount,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
    };
  }

  if (charge.taxRatePercent === undefined) {
    // Required rather than defaulted: GST on a composite supply follows the
    // principal supply's rate, and guessing it under-collects tax.
    throw new ValidationError(
      `Additional charge "${charge.label}" is taxable but has no tax rate.`,
      { details: { chargeId: charge.id } },
    );
  }

  const tax = percentOf(charge.amount, charge.taxRatePercent);
  const { cgst, sgst } = supplyType === 'intra_state' ? splitCgstSgst(tax) : { cgst: 0, sgst: 0 };

  return {
    taxable: true,
    taxRatePercent: charge.taxRatePercent,
    taxableAmount: charge.amount,
    cgst,
    sgst,
    igst: supplyType === 'inter_state' ? tax : 0,
    cess: 0,
  };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** The tax breakup block printed on the invoice, grouped by rate. */
function buildTaxSummary(
  lines: readonly TaxLineResult[],
  charges: readonly ChargeResult[],
): TaxRateSummary[] {
  const byRate = new Map<number, TaxRateSummary>();

  const add = (
    rate: number,
    taxable: number,
    cgst: number,
    sgst: number,
    igst: number,
    cess: number,
  ) => {
    const existing = byRate.get(rate);
    byRate.set(rate, {
      taxRatePercent: rate,
      taxableAmount: (existing?.taxableAmount ?? 0) + taxable,
      cgst: (existing?.cgst ?? 0) + cgst,
      sgst: (existing?.sgst ?? 0) + sgst,
      igst: (existing?.igst ?? 0) + igst,
      cess: (existing?.cess ?? 0) + cess,
    });
  };

  for (const line of lines) {
    add(line.taxRatePercent, line.taxableAmount, line.cgst, line.sgst, line.igst, line.cess);
  }
  for (const charge of charges) {
    if (charge.taxable) {
      add(
        charge.taxRatePercent,
        charge.taxableAmount,
        charge.cgst,
        charge.sgst,
        charge.igst,
        charge.cess,
      );
    }
  }

  return [...byRate.values()].sort((a, b) => a.taxRatePercent - b.taxRatePercent);
}

/** GSTR-1 requires sales aggregated by HSN code. Lines without one are omitted. */
function buildHsnSummary(
  inputs: readonly TaxLineInput[],
  results: readonly TaxLineResult[],
): HsnSummary[] {
  const byHsn = new Map<string, HsnSummary & { quantity: number }>();

  results.forEach((line, index) => {
    const hsn = line.hsnCode;
    if (!hsn) return;

    const quantity = inputs[index]?.quantity ?? 0;
    const existing = byHsn.get(hsn);

    byHsn.set(hsn, {
      hsnCode: hsn,
      quantity: (existing?.quantity ?? 0) + quantity,
      taxableAmount: (existing?.taxableAmount ?? 0) + line.taxableAmount,
      cgst: (existing?.cgst ?? 0) + line.cgst,
      sgst: (existing?.sgst ?? 0) + line.sgst,
      igst: (existing?.igst ?? 0) + line.igst,
      cess: (existing?.cess ?? 0) + line.cess,
    });
  });

  return [...byHsn.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode));
}
