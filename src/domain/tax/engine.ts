/**
 * The GST tax engine. Pure — no clock, I/O or randomness — because the Dart
 * port on the device must produce identical totals for offline billing.
 *
 * Order of operations (changing it changes every total in the system):
 *   1. line gross = unitPrice × quantity
 *   2. line discount
 *   3. bill discount, apportioned by post-line-discount value (largest remainder)
 *   4. back tax out of inclusive prices: taxable = net × 100 / (100 + rate + cess)
 *   5. tax per line; CGST/SGST halves intra-state, IGST inter-state
 *   6. additional charges
 *   7. round-off to the rupee, reported separately
 *
 * Rounding is half away from zero, once per line, and totals are summed from
 * rounded lines. Rounding the total independently leaves printed lines that do
 * not add up to the printed total.
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
  SupplyCategory,
  SupplyCategoryTotals,
  SupplyType,
  TaxEngineRules,
  TaxInvoiceInput,
  TaxInvoiceResult,
  TaxLineResult,
  TaxRateSummary,
} from './types.js';

/** Clamped to the base: an oversized discount must not create negative tax. */
function resolveDiscount(discount: Discount | undefined, base: number): number {
  if (!discount) return 0;
  const amount =
    discount.kind === 'percent' ? percentOf(base, discount.value) : Math.trunc(discount.value);
  if (amount < 0)
    throw new ValidationError('A discount cannot be negative.', { details: { discount } });
  return Math.min(amount, base);
}

/** A walk-in sale has no customer state; goods changing hands in the shop is intra-state. */
export function resolveSupplyType(
  supplierStateCode: string,
  placeOfSupplyStateCode: string | undefined,
): SupplyType {
  if (!placeOfSupplyStateCode) return 'intra_state';
  return placeOfSupplyStateCode === supplierStateCode ? 'intra_state' : 'inter_state';
}

/**
 * Lines with no HSN still have to appear in the GSTR-1 HSN table, which must
 * account for the whole invoice. They are bucketed under this key rather than
 * dropped, so the table reconciles and the omission is visible to whoever has
 * to fix the catalogue.
 */
export const HSN_UNCLASSIFIED = 'UNCLASSIFIED';

/** Everything but a plain intra-state supply puts its tax under IGST. */
function isIntraState(supplyType: SupplyType): boolean {
  return supplyType === 'intra_state';
}

/** Zero-rated supplies are reported at value and carry no tax. */
function supplyTypeChargesTax(supplyType: SupplyType): boolean {
  return supplyType !== 'export_without_tax' && supplyType !== 'sez_without_tax';
}

/** The odd paisa goes to CGST. The rule must match the client and every credit note. */
function splitCgstSgst(tax: number): { cgst: number; sgst: number } {
  const cgst = roundHalfAwayFromZero(tax / 2);
  return { cgst, sgst: tax - cgst };
}

function extractTaxable(
  inclusive: number,
  taxRatePercent: number,
  cessRatePercent: number,
): number {
  const totalRate = taxRatePercent + cessRatePercent;
  return totalRate === 0 ? inclusive : roundHalfAwayFromZero((inclusive * 100) / (100 + totalRate));
}

function assertRate(rate: number, rules: TaxEngineRules, details: Record<string, unknown>): void {
  if (!rules.allowedGstRates.has(rate)) {
    throw new ValidationError(`${rate}% is not a notified GST rate.`, {
      details: { ...details, rate },
    });
  }
}

function validateInput(input: TaxInvoiceInput, rules: TaxEngineRules): void {
  if (input.lines.length === 0)
    throw new ValidationError('An invoice must have at least one line.');
  if (!/^[0-9]{2}$/.test(input.supplierStateCode)) {
    throw new ValidationError('The supplier state code must be two digits.');
  }

  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError('Quantity must be a positive whole number of thousandths.', {
        details: { lineId: line.id },
      });
    }
    if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) {
      throw new ValidationError('Unit price must be a non-negative whole number of paise.', {
        details: { lineId: line.id },
      });
    }
    // Unregistered and composition documents charge no tax, so their stored
    // rates are informational and not validated. Nor is an exempt, nil-rated
    // or non-GST line: it has no notified rate to check against.
    if (input.mode === 'gst' && (line.supplyCategory ?? 'taxable') === 'taxable') {
      assertRate(line.taxRatePercent, rules, { lineId: line.id });
    }
  }

  // An export or SEZ supply leaves the state, so a declared one that resolves
  // intra-state means the place of supply and the declaration disagree — and
  // whichever is wrong, the return would be too.
  if (
    input.supplyType &&
    input.supplyType !== 'intra_state' &&
    input.supplyType !== 'inter_state' &&
    resolveSupplyType(input.supplierStateCode, input.placeOfSupplyStateCode) === 'intra_state' &&
    input.placeOfSupplyStateCode !== undefined
  ) {
    throw new ValidationError(
      'An export or SEZ supply cannot have a place of supply in the supplier state.',
      { details: { supplyType: input.supplyType, placeOfSupply: input.placeOfSupplyStateCode } },
    );
  }
}

interface ChargeResult {
  taxable: boolean;
  taxRatePercent: number;
  amount: number;
  cgst: number;
  sgst: number;
  igst: number;
}

function computeCharge(
  charge: AdditionalCharge,
  supplyType: SupplyType,
  taxesApply: boolean,
  rules: TaxEngineRules,
): ChargeResult {
  if (!charge.taxable || !taxesApply) {
    return { taxable: false, taxRatePercent: 0, amount: charge.amount, cgst: 0, sgst: 0, igst: 0 };
  }
  if (charge.taxRatePercent === undefined) {
    throw new ValidationError(
      `Additional charge "${charge.label}" is taxable but has no tax rate.`,
      {
        details: { chargeId: charge.id },
      },
    );
  }
  assertRate(charge.taxRatePercent, rules, { chargeId: charge.id });

  const tax = percentOf(charge.amount, charge.taxRatePercent);
  const { cgst, sgst } = supplyType === 'intra_state' ? splitCgstSgst(tax) : { cgst: 0, sgst: 0 };
  return {
    taxable: true,
    taxRatePercent: charge.taxRatePercent,
    amount: charge.amount,
    cgst,
    sgst,
    igst: isIntraState(supplyType) ? 0 : tax,
  };
}

export function computeInvoice(input: TaxInvoiceInput, rules: TaxEngineRules): TaxInvoiceResult {
  validateInput(input, rules);

  const supplyType =
    input.supplyType ?? resolveSupplyType(input.supplierStateCode, input.placeOfSupplyStateCode);
  // Three independent reasons a document carries no tax: the shop is not a
  // regular registered dealer, the supply is zero-rated, or the recipient
  // pays under reverse charge. Values are still reported in every case.
  const isReverseCharge = input.isReverseCharge ?? false;
  const taxesApply =
    input.mode === 'gst' && supplyTypeChargesTax(supplyType) && !isReverseCharge;

  const grossAmounts = input.lines.map((line) => lineAmount(line.unitPrice, line.quantity));
  const lineDiscounts = input.lines.map((line, i) =>
    resolveDiscount(line.discount, grossAmounts[i] ?? 0),
  );
  const afterLineDiscount = grossAmounts.map((gross, i) => gross - (lineDiscounts[i] ?? 0));

  // Weighted by post-discount value, so a line already discounted to zero absorbs none.
  const billDiscountTotal = resolveDiscount(input.billDiscount, sum(afterLineDiscount));
  const billDiscountShares = distribute(billDiscountTotal, afterLineDiscount);

  const lines: TaxLineResult[] = input.lines.map((line, i) => {
    const net = (afterLineDiscount[i] ?? 0) - (billDiscountShares[i] ?? 0);
    const supplyCategory: SupplyCategory = line.supplyCategory ?? 'taxable';
    // An exempt, nil-rated or non-GST line bears no tax whatever rate is
    // recorded against it; the rate is kept because the catalogue carries it.
    const lineTaxesApply = taxesApply && supplyCategory === 'taxable';
    const taxRate = lineTaxesApply ? line.taxRatePercent : 0;
    const cessRate = lineTaxesApply ? (line.cessRatePercent ?? 0) : 0;

    const taxableAmount = input.pricesIncludeTax ? extractTaxable(net, taxRate, cessRate) : net;
    const tax = percentOf(taxableAmount, taxRate);
    const cess = percentOf(taxableAmount, cessRate);
    const { cgst, sgst } = isIntraState(supplyType) ? splitCgstSgst(tax) : { cgst: 0, sgst: 0 };
    const igst = isIntraState(supplyType) ? 0 : tax;

    return {
      id: line.id,
      grossAmount: grossAmounts[i] ?? 0,
      lineDiscount: lineDiscounts[i] ?? 0,
      apportionedBillDiscount: billDiscountShares[i] ?? 0,
      taxableAmount,
      taxRatePercent: line.taxRatePercent,
      cessRatePercent: line.cessRatePercent ?? 0,
      cgst,
      sgst,
      igst,
      cess,
      lineTotal: taxableAmount + cgst + sgst + igst + cess,
      hsnCode: line.hsnCode,
      supplyCategory,
    };
  });

  const charges = (input.additionalCharges ?? []).map((c) =>
    computeCharge(c, supplyType, taxesApply, rules),
  );
  const taxableCharges = sum(charges.filter((c) => c.taxable).map((c) => c.amount));
  const nonTaxableCharges = sum(charges.filter((c) => !c.taxable).map((c) => c.amount));

  const totalCgst = sum([...lines.map((l) => l.cgst), ...charges.map((c) => c.cgst)]);
  const totalSgst = sum([...lines.map((l) => l.sgst), ...charges.map((c) => c.sgst)]);
  const totalIgst = sum([...lines.map((l) => l.igst), ...charges.map((c) => c.igst)]);
  const totalCess = sum(lines.map((l) => l.cess));
  const totalTax = totalCgst + totalSgst + totalIgst + totalCess;
  const taxableAmount = sum(lines.map((l) => l.taxableAmount)) + taxableCharges;
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
    taxSummary: buildTaxSummary(lines, charges),
    hsnSummary: buildHsnSummary(
      input.lines.map((l) => l.quantity),
      lines,
    ),
    categoryTotals: buildCategoryTotals(lines),
    isReverseCharge,
  };
}

/**
 * Taxable value per classification. Taxable charges land under `taxable`:
 * a charge is part of the principal supply and is taxed at its rate.
 */
function buildCategoryTotals(lines: readonly TaxLineResult[]): SupplyCategoryTotals {
  const totals = { taxable: 0, exempt: 0, nilRated: 0, nonGst: 0 };
  for (const line of lines) {
    if (line.supplyCategory === 'exempt') totals.exempt += line.taxableAmount;
    else if (line.supplyCategory === 'nil_rated') totals.nilRated += line.taxableAmount;
    else if (line.supplyCategory === 'non_gst') totals.nonGst += line.taxableAmount;
    else totals.taxable += line.taxableAmount;
  }
  return totals;
}

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
    const prev = byRate.get(rate);
    byRate.set(rate, {
      taxRatePercent: rate,
      taxableAmount: (prev?.taxableAmount ?? 0) + taxable,
      cgst: (prev?.cgst ?? 0) + cgst,
      sgst: (prev?.sgst ?? 0) + sgst,
      igst: (prev?.igst ?? 0) + igst,
      cess: (prev?.cess ?? 0) + cess,
    });
  };
  for (const l of lines) add(l.taxRatePercent, l.taxableAmount, l.cgst, l.sgst, l.igst, l.cess);
  for (const c of charges)
    if (c.taxable) add(c.taxRatePercent, c.amount, c.cgst, c.sgst, c.igst, 0);
  return [...byRate.values()].sort((a, b) => a.taxRatePercent - b.taxRatePercent);
}

function buildHsnSummary(
  quantities: readonly number[],
  lines: readonly TaxLineResult[],
): HsnSummary[] {
  const byHsn = new Map<string, HsnSummary>();
  lines.forEach((line, i) => {
    const hsnCode = line.hsnCode || HSN_UNCLASSIFIED;
    const prev = byHsn.get(hsnCode);
    byHsn.set(hsnCode, {
      hsnCode,
      quantity: (prev?.quantity ?? 0) + (quantities[i] ?? 0),
      taxableAmount: (prev?.taxableAmount ?? 0) + line.taxableAmount,
      cgst: (prev?.cgst ?? 0) + line.cgst,
      sgst: (prev?.sgst ?? 0) + line.sgst,
      igst: (prev?.igst ?? 0) + line.igst,
      cess: (prev?.cess ?? 0) + line.cess,
    });
  });
  return [...byHsn.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode));
}
