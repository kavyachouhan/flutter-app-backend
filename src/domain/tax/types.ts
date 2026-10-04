/**
 * Tax engine contract, mirrored by the Dart implementation in the Flutter app.
 * Amounts are integer paise; quantities are thousandths of a unit.
 */

/**
 * Where the supply goes, which decides which tax heads apply.
 *
 * The first two are derived from the place of supply. The rest cannot be —
 * nothing about a state code says a shipment is an export or goes to an SEZ —
 * so a caller declares them. Both `_without_tax` forms are zero-rated: the
 * supply is reported but no tax is charged on it.
 */
export type SupplyType =
  | 'intra_state'
  | 'inter_state'
  | 'export_with_tax'
  | 'export_without_tax'
  | 'sez_with_tax'
  | 'sez_without_tax';

/**
 * How a line is classified for the return, as distinct from what it is taxed
 * at. A zero-rate line is not evidence of anything: it may be a taxable good
 * notified at 0%, an exempt supply, a nil-rated one, or outside GST
 * altogether, and GSTR-1 table 8 and GSTR-3B table 3.1 report the four
 * separately. Nothing but the seller knows which, so it is recorded, never
 * inferred from the rate.
 */
export type SupplyCategory = 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';

/**
 * gst          registered dealer, CGST/SGST/IGST charged
 * non_gst      unregistered shop, no tax on the document
 * composition  pays a flat rate on turnover and may not charge tax to the
 *              customer; item rates are still recorded
 */
export type TaxMode = 'gst' | 'non_gst' | 'composition';

export type Discount =
  | { readonly kind: 'amount'; readonly value: number }
  | { readonly kind: 'percent'; readonly value: number };

export interface TaxLineInput {
  readonly id: string;
  readonly quantity: number;
  /** Per whole unit; tax-inclusive or exclusive per `pricesIncludeTax`. */
  readonly unitPrice: number;
  readonly taxRatePercent: number;
  readonly cessRatePercent?: number;
  readonly discount?: Discount;
  readonly hsnCode?: string;
  /** Defaults to `taxable`, which is what every line was before this existed. */
  readonly supplyCategory?: SupplyCategory;
}

export interface AdditionalCharge {
  readonly id: string;
  readonly label: string;
  readonly amount: number;
  readonly taxable: boolean;
  /** Required when taxable: a composite supply takes the principal supply's rate, which cannot be guessed. */
  readonly taxRatePercent?: number;
}

export interface TaxInvoiceInput {
  readonly mode: TaxMode;
  readonly supplierStateCode: string;
  readonly placeOfSupplyStateCode?: string;
  /**
   * Declares an export or SEZ supply. Omitted, the supply type is derived
   * from the place of supply as it always was.
   */
  readonly supplyType?: SupplyType;
  /**
   * Reverse charge: the recipient pays the tax, so the document carries none
   * while still reporting the value. Rates stay on the lines, because the
   * recipient computes its liability from them.
   */
  readonly isReverseCharge?: boolean;
  readonly pricesIncludeTax: boolean;
  readonly lines: readonly TaxLineInput[];
  readonly billDiscount?: Discount;
  readonly additionalCharges?: readonly AdditionalCharge[];
  readonly roundOff: boolean;
}

/** Legal parameters, supplied by the caller so the engine stays pure and law changes are config. */
export interface TaxEngineRules {
  readonly allowedGstRates: ReadonlySet<number>;
}

export interface TaxLineResult {
  readonly id: string;
  readonly grossAmount: number;
  readonly lineDiscount: number;
  readonly apportionedBillDiscount: number;
  readonly taxableAmount: number;
  readonly taxRatePercent: number;
  readonly cessRatePercent: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
  readonly lineTotal: number;
  readonly hsnCode: string | undefined;
  readonly supplyCategory: SupplyCategory;
}

export interface TaxRateSummary {
  readonly taxRatePercent: number;
  readonly taxableAmount: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
}

/** GSTR-1 reports sales aggregated by HSN. */
export interface HsnSummary extends Omit<TaxRateSummary, 'taxRatePercent'> {
  readonly hsnCode: string;
  readonly quantity: number;
}

/**
 * Value by classification, which is what the return asks for and what no
 * amount of re-reading the rate can recover. Each is a sum of taxable values,
 * so the four plus nothing else account for every line.
 */
export interface SupplyCategoryTotals {
  readonly taxable: number;
  readonly exempt: number;
  readonly nilRated: number;
  readonly nonGst: number;
}

export interface TaxInvoiceResult {
  readonly supplyType: SupplyType;
  readonly mode: TaxMode;
  readonly lines: readonly TaxLineResult[];
  readonly grossAmount: number;
  readonly totalLineDiscount: number;
  readonly billDiscount: number;
  readonly totalDiscount: number;
  readonly taxableAmount: number;
  readonly totalCgst: number;
  readonly totalSgst: number;
  readonly totalIgst: number;
  readonly totalCess: number;
  readonly totalTax: number;
  readonly taxableCharges: number;
  readonly nonTaxableCharges: number;
  readonly subTotal: number;
  readonly roundOff: number;
  readonly grandTotal: number;
  readonly taxSummary: readonly TaxRateSummary[];
  readonly hsnSummary: readonly HsnSummary[];
  readonly categoryTotals: SupplyCategoryTotals;
  readonly isReverseCharge: boolean;
}
