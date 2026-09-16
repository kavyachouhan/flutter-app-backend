/**
 * Tax engine contract, mirrored by the Dart implementation in the Flutter app.
 * Amounts are integer paise; quantities are thousandths of a unit.
 */

export type SupplyType = 'intra_state' | 'inter_state';

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
}
