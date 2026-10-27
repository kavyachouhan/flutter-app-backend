/**
 * The print payload contract, mirrored by `PrintDocument` in the Flutter
 * package `khata_printing`.
 *
 * Two rules shape it:
 *
 * 1. Every string is already formatted. The renderer never looks anything up,
 *    never consults a locale and never does arithmetic.
 * 2. It describes the document, not the layout. Where the total sits and how a
 *    long item name wraps is the renderer's business — a tenant-authored
 *    layout would be a rendering-compatibility problem across ESC/POS and PDF
 *    forever.
 */

export type PrintDocumentKind =
  | 'invoice'
  | 'credit_note'
  | 'payment_receipt'
  | 'estimate'
  | 'sales_order';

export interface PrintField {
  readonly label: string;
  readonly value: string;
}

export interface PrintBusiness {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly phone?: string;
  readonly gstin?: string;
  readonly email?: string;
  /** Storage key, not a URL: URLs expire and the printer may be offline. */
  readonly logoObjectKey?: string;
  readonly upiId?: string;
  readonly bankLines: readonly string[];
}

export interface PrintParty {
  readonly name: string;
  readonly phone?: string;
  readonly gstin?: string;
  readonly addressLines: readonly string[];
  /** Place of supply, which GST requires on a B2B invoice. */
  readonly stateName?: string;
}

export interface PrintLineItem {
  readonly name: string;
  readonly quantity: string;
  readonly rate: string;
  readonly amount: string;
  readonly hsnCode?: string;
  readonly unit?: string;
  readonly discount?: string;
  readonly taxRate?: string;
  readonly note?: string;
}

export interface PrintAmountRow {
  readonly label: string;
  readonly amount: string;
  /** The grand total, printed large. At most one row carries it. */
  readonly emphasis?: boolean;
  /** Raw value, so a renderer can skip a zero row without parsing text. */
  readonly paise?: number;
}

export interface PrintTaxRow {
  readonly rate: string;
  readonly taxable: string;
  readonly cgst?: string;
  readonly sgst?: string;
  readonly igst?: string;
  readonly cess?: string;
}

export interface PrintDocument {
  readonly kind: PrintDocumentKind;
  /**
   * "TAX INVOICE", "BILL OF SUPPLY", "CREDIT NOTE". Decided here rather than
   * on the device because getting it wrong is a compliance problem.
   */
  readonly title: string;
  readonly business: PrintBusiness;
  readonly customer?: PrintParty;
  readonly meta: readonly PrintField[];
  readonly items: readonly PrintLineItem[];
  readonly totals: readonly PrintAmountRow[];
  readonly taxRows: readonly PrintTaxRow[];
  readonly tenders: readonly PrintAmountRow[];
  readonly customFields: readonly PrintField[];
  readonly amountInWords?: string;
  readonly qrPayload?: string;
  readonly qrCaption?: string;
  readonly footerLines: readonly string[];
  readonly termsLines: readonly string[];
  readonly signatureLabel?: string;
  readonly copyLabel?: string;
  readonly showHsn: boolean;
  readonly showTaxColumn: boolean;
}
