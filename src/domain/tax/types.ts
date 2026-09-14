/**
 * Tax engine contract.
 *
 * This file is the specification the Dart implementation in the Flutter app
 * mirrors. Both sides compute totals from the same input and must agree to the
 * paisa: the device bills offline and the server re-checks on sync, so any
 * divergence surfaces as a rejected invoice for a sale that already happened
 * and whose cash is already in the drawer.
 *
 * Every amount is integer paise. Every quantity is thousandths of a unit, so
 * 1.5 kg is 1500. No floats.
 */

/** GST supply type, derived from the place of supply — never sent by a client. */
export type SupplyType = 'intra_state' | 'inter_state';

/**
 * How the business is registered. This is the top-level switch: a large share
 * of small shops are unregistered, and the product treats that as a
 * first-class mode rather than as GST with blank fields.
 */
export type TaxMode =
  /** Registered: full CGST/SGST/IGST on the invoice. */
  | 'gst'
  /** Unregistered: no tax columns at all, no GSTIN on the document. */
  | 'non_gst'
  /**
   * Composition dealer: charges no tax to the customer and pays a flat rate
   * on turnover. The invoice must show no tax and carry the prescribed
   * declaration, so tax is computed as zero but rates are still recorded.
   */
  | 'composition';

/** Line-level or bill-level discount. */
export type Discount =
  | { readonly kind: 'amount'; readonly value: number }
  | { readonly kind: 'percent'; readonly value: number };

export interface TaxLineInput {
  /** Stable identifier, echoed back so callers can match results to lines. */
  readonly id: string;

  /** Thousandths of a unit. 1 piece = 1000; 0.25 kg = 250. */
  readonly quantity: number;

  /**
   * Price for one whole unit, in paise. Inclusive or exclusive of tax
   * according to `pricesIncludeTax` on the invoice.
   */
  readonly unitPrice: number;

  /** GST rate for this line: 0, 0.25, 3, 5, 12, 18 or 28. */
  readonly taxRatePercent: number;

  /** Compensation cess, for tobacco, aerated drinks, cars. Usually absent. */
  readonly cessRatePercent?: number;

  readonly discount?: Discount;

  /** Carried through to the output for the HSN summary GSTR-1 needs. */
  readonly hsnCode?: string;
}

/**
 * A charge added at the bill level — delivery, packing, installation.
 *
 * `taxRatePercent` is required when taxable because GST on a composite supply
 * follows the principal supply's rate; defaulting it would quietly under-
 * collect tax.
 */
export interface AdditionalCharge {
  readonly id: string;
  readonly label: string;
  readonly amount: number;
  readonly taxable: boolean;
  readonly taxRatePercent?: number;
}

export interface TaxInvoiceInput {
  readonly mode: TaxMode;

  /** Supplier's state code (the outlet's, falling back to the tenant's). */
  readonly supplierStateCode: string;

  /**
   * Customer's state code. Absent for a walk-in cash sale, which is treated
   * as intra-state — the correct default for over-the-counter retail.
   */
  readonly placeOfSupplyStateCode?: string;

  /** When true, `unitPrice` already contains tax and is backed out. */
  readonly pricesIncludeTax: boolean;

  readonly lines: readonly TaxLineInput[];

  /** Applied after line discounts, apportioned across lines by taxable value. */
  readonly billDiscount?: Discount;

  readonly additionalCharges?: readonly AdditionalCharge[];

  /** Rounds the grand total to the nearest rupee and reports the adjustment. */
  readonly roundOff: boolean;
}

export interface TaxLineResult {
  readonly id: string;

  /** unitPrice × quantity, before any discount. */
  readonly grossAmount: number;

  readonly lineDiscount: number;
  /** This line's share of the bill-level discount. */
  readonly apportionedBillDiscount: number;

  /** The value tax is charged on, after all discounts and tax back-out. */
  readonly taxableAmount: number;

  readonly taxRatePercent: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;

  /** taxableAmount + cgst + sgst + igst + cess. */
  readonly lineTotal: number;

  readonly hsnCode: string | undefined;
}

/** One row of the tax breakup printed on the invoice, grouped by rate. */
export interface TaxRateSummary {
  readonly taxRatePercent: number;
  readonly taxableAmount: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
}

/** Per-HSN aggregation, required for GSTR-1's HSN summary table. */
export interface HsnSummary {
  readonly hsnCode: string;
  readonly quantity: number;
  readonly taxableAmount: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
}

export interface TaxInvoiceResult {
  readonly supplyType: SupplyType;
  readonly mode: TaxMode;

  readonly lines: readonly TaxLineResult[];

  /** Sum of line gross amounts, before any discount. */
  readonly grossAmount: number;
  readonly totalLineDiscount: number;
  readonly billDiscount: number;
  readonly totalDiscount: number;

  /** Sum of line taxable amounts, plus taxable additional charges. */
  readonly taxableAmount: number;

  readonly totalCgst: number;
  readonly totalSgst: number;
  readonly totalIgst: number;
  readonly totalCess: number;
  readonly totalTax: number;

  readonly taxableCharges: number;
  readonly nonTaxableCharges: number;

  /** Total before the round-off adjustment. */
  readonly subTotal: number;
  readonly roundOff: number;
  readonly grandTotal: number;

  readonly taxSummary: readonly TaxRateSummary[];
  readonly hsnSummary: readonly HsnSummary[];
}
