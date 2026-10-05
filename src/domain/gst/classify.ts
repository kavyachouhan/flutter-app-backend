/**
 * Which GSTR-1 table a supply belongs in.
 *
 * Pure, so the decisions can be unit-tested against the rules rather than
 * against a database, and so a client can preview a return without asking.
 *
 * The classification is not a formatting detail. Put a B2C sale in the B2B
 * table and the buyer claims credit they are not entitled to; put a large
 * inter-state B2C sale in the small table and the state it was supplied to
 * never sees it. Both are the shop's declaration, so each rule here is
 * written to the reason for it.
 */

/**
 * The GSTR-1 tables this system reports. Amendment tables (9A, 9B, 9C) are
 * deliberately absent: an amendment restates a *filed* period, which needs the
 * previously filed figures to diff against, and nothing has filed a period
 * yet. They belong with the filing integration, not with the workings.
 */
export type Gstr1Table =
  /** 4A/4B: registered buyer. The buyer's credit depends on this being right. */
  | 'b2b'
  /** 5: inter-state, unregistered buyer, invoice value above the threshold. */
  | 'b2cl'
  /** 7: everything else to an unregistered buyer, reported as a rate-wise total. */
  | 'b2cs'
  /** 6A: exports, with or without payment of tax. */
  | 'export'
  /** 6B: supplies to an SEZ unit or developer. */
  | 'sez'
  /** 9B: credit and debit notes to a registered buyer. */
  | 'cdnr'
  /** 9B: credit and debit notes to an unregistered buyer. */
  | 'cdnur'
  /** 8: nil-rated, exempt and non-GST outward supplies. */
  | 'nil_exempt_non_gst';

/**
 * Invoice value above which an inter-state sale to an unregistered buyer is
 * reported individually (B2CL, table 5) rather than inside a rate-wise total.
 *
 * ₹2.5 lakh, in paise. A constant rather than configuration because it is a
 * statutory figure, and a shop that could change it would file a wrong return
 * without knowing. It moves by notification, which is a code change with a
 * test, as it should be.
 */
export const B2CL_THRESHOLD_PAISE = 25_000_000;

export type SupplyCategory = 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';

export type SupplyType =
  | 'intra_state'
  | 'inter_state'
  | 'export_with_tax'
  | 'export_without_tax'
  | 'sez_with_tax'
  | 'sez_without_tax';

export interface ClassifiableDocument {
  /** Null or absent for a walk-in sale. */
  readonly customerGstin?: string | null;
  readonly supplyType: SupplyType;
  /** The whole document's value including tax, which the B2CL test is on. */
  readonly grandTotal: number;
  /** A credit note or debit note goes to the CDN tables, not the sales ones. */
  readonly isCreditOrDebitNote?: boolean;
  /**
   * The classifications present on the document's lines. A document with only
   * exempt, nil-rated or non-GST lines is reported in table 8 instead of as a
   * supply — it is not a taxable supply at all.
   */
  readonly lineCategories?: readonly SupplyCategory[];
}

/** True when every line is outside the taxable tables. */
function isWhollyNonTaxable(categories: readonly SupplyCategory[] | undefined): boolean {
  if (!categories || categories.length === 0) return false;
  return categories.every((category) => category !== 'taxable');
}

/**
 * The table a document belongs in.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Export and SEZ first. They are zero-rated supplies with their own
 *      tables, and both can go to a buyer who happens to hold a GSTIN — so
 *      testing for a GSTIN first would file an export as an ordinary B2B sale
 *      and lose the refund claim.
 *   2. Wholly non-taxable next. An exempt sale to a registered buyer is still
 *      an exempt supply; there is no credit to pass on, so it is not B2B.
 *   3. Then the GSTIN test, which is what separates B2B from B2C.
 *   4. B2CL only for inter-state above the threshold. An intra-state sale of
 *      any size is B2CS, because the state already receives the tax.
 */
export function classifyOutward(document: ClassifiableDocument): Gstr1Table {
  const registered = Boolean(document.customerGstin);

  if (document.supplyType === 'export_with_tax' || document.supplyType === 'export_without_tax') {
    return 'export';
  }
  if (document.supplyType === 'sez_with_tax' || document.supplyType === 'sez_without_tax') {
    return 'sez';
  }

  if (document.isCreditOrDebitNote) return registered ? 'cdnr' : 'cdnur';

  if (isWhollyNonTaxable(document.lineCategories)) return 'nil_exempt_non_gst';

  if (registered) return 'b2b';

  if (document.supplyType === 'inter_state' && document.grandTotal > B2CL_THRESHOLD_PAISE) {
    return 'b2cl';
  }
  return 'b2cs';
}

/**
 * Whether a document of this table is reported row by row or only as a total.
 *
 * B2CS is a rate-wise aggregate by place of supply — the portal does not want
 * a line per corner-shop sale, and a shop doing two hundred bills a day would
 * file a return nobody could upload.
 */
export function isAggregated(table: Gstr1Table): boolean {
  return table === 'b2cs' || table === 'nil_exempt_non_gst';
}

/**
 * The 3B section a supply contributes to.
 *
 * 3.1(a) outward taxable (other than zero-rated, nil-rated, exempt)
 * 3.1(b) outward zero-rated
 * 3.1(c) outward nil-rated and exempt
 * 3.1(d) inward liable to reverse charge
 * 3.1(e) non-GST outward
 */
export type Gstr3bSection = '3.1a' | '3.1b' | '3.1c' | '3.1d' | '3.1e';

export function sectionForOutward(
  supplyType: SupplyType,
  category: SupplyCategory,
): Gstr3bSection {
  if (supplyType.startsWith('export') || supplyType.startsWith('sez')) return '3.1b';
  if (category === 'non_gst') return '3.1e';
  if (category === 'exempt' || category === 'nil_rated') return '3.1c';
  return '3.1a';
}

/**
 * Normalises a supplier invoice number for matching against GSTR-2B.
 *
 * The same normalisation the duplicate-bill index already applies to our own
 * bills (`upper(trim(...))`), plus the separators a human types and the portal
 * does not. `INV-001`, `inv 001` and `INV001` are one number keyed in three
 * ways, and treating them as three is how a reconciliation reports a gap that
 * is really a typo — sending the shopkeeper to chase a supplier who filed
 * correctly.
 *
 * Deliberately not applied to our stored column: the number printed on the
 * supplier's bill is a fact and stays as entered. This is a comparison key.
 */
export function normaliseInvoiceNumber(invoiceNo: string): string {
  return invoiceNo.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The period a date falls in, as the `YYYY-MM` the ITC register stores. */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}
