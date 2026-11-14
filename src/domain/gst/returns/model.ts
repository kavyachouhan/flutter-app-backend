/**
 * The neutral return model.
 *
 * This is what BillBanao *means* by a GSTR-1 and a GSTR-3B. It carries no GSTN key names, no
 * GSTN date or number formats and no GSTN code lists: every amount is integer paise, dates are
 * ISO `YYYY-MM-DD`, and classifications are our own enums. A versioned mapper (see `./mappers`)
 * is the only thing that turns it into a portal payload, so a portal format change is a new
 * mapper, never a change here and never a migration.
 *
 * The workings (report screen, PDF, Excel, CA package) are produced from this same model, which
 * is what keeps every export identical to what the screen shows.
 */

/** Integer paise. Negative is allowed where the return allows it (amendment-style netting). */
export type Paise = number;

export interface TaxAmounts {
  readonly igst: Paise;
  readonly cgst: Paise;
  readonly sgst: Paise;
  readonly cess: Paise;
}

export interface TaxedValue extends TaxAmounts {
  readonly taxable: Paise;
}

export const ZERO_TAX: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
export const ZERO_TAXED: TaxedValue = { taxable: 0, ...ZERO_TAX };

export interface ReturnPeriod {
  readonly year: number;
  /** 1-12. For a quarterly filer this is the quarter-end month. */
  readonly month: number;
}

// --- GSTR-1 -----------------------------------------------------------------

export type RecipientKind =
  /** Regular registered buyer (GSTN `R`). */
  | 'regular'
  /** SEZ unit/developer, supply with payment of tax. */
  | 'sez_with_payment'
  /** SEZ unit/developer, supply without payment of tax. */
  | 'sez_without_payment'
  /** Deemed export. */
  | 'deemed_export';

export interface Gstr1Line {
  /** Tax rate as a percent number, e.g. 18 or 0.25. */
  readonly ratePercent: number;
  readonly value: TaxedValue;
}

export interface Gstr1Invoice {
  readonly number: string;
  readonly date: string;
  /** Whole document value including tax. */
  readonly value: Paise;
  /** GST state code, two digits ('96' foreign, '97' other territory). */
  readonly placeOfSupply: string;
  readonly reverseCharge: boolean;
  readonly recipientKind: RecipientKind;
  /** E-commerce operator GSTIN when sold through one. */
  readonly ecommerceGstin?: string;
  readonly lines: readonly Gstr1Line[];
}

export interface Gstr1B2bParty {
  readonly recipientGstin: string;
  readonly invoices: readonly Gstr1Invoice[];
}

export interface Gstr1B2clGroup {
  readonly placeOfSupply: string;
  readonly invoices: readonly Omit<
    Gstr1Invoice,
    'placeOfSupply' | 'reverseCharge' | 'recipientKind'
  >[];
}

export interface Gstr1B2csRow {
  readonly intraState: boolean;
  readonly placeOfSupply: string;
  readonly ratePercent: number;
  readonly viaEcommerce: boolean;
  readonly ecommerceGstin?: string;
  readonly value: TaxedValue;
}

export type NoteKind = 'credit' | 'debit';

export interface Gstr1Note {
  readonly kind: NoteKind;
  readonly number: string;
  readonly date: string;
  readonly value: Paise;
  readonly placeOfSupply: string;
  readonly reverseCharge: boolean;
  readonly recipientKind: RecipientKind;
  /** The invoice the note relates to, kept for the CA package and the audit trail. */
  readonly originalInvoiceNumber?: string;
  readonly originalInvoiceDate?: string;
  readonly lines: readonly Gstr1Line[];
}

export interface Gstr1NoteParty {
  readonly recipientGstin: string;
  readonly notes: readonly Gstr1Note[];
}

export type UnregisteredNoteKind = 'b2cl' | 'export_with_payment' | 'export_without_payment';

export interface Gstr1UnregisteredNote {
  readonly kind: NoteKind;
  readonly type: UnregisteredNoteKind;
  readonly number: string;
  readonly date: string;
  readonly value: Paise;
  readonly placeOfSupply: string;
  readonly lines: readonly Gstr1Line[];
}

export type ExportType = 'with_payment' | 'without_payment';

export interface Gstr1ShippingBill {
  readonly number: string;
  readonly date: string;
  readonly portCode: string;
}

/** Table 6A: an export invoice. */
export interface Gstr1Export {
  readonly exportType: ExportType;
  readonly number: string;
  readonly date: string;
  readonly value: Paise;
  /** Not held anywhere yet; the portal accepts the invoice without it. */
  readonly shippingBill?: Gstr1ShippingBill;
  readonly lines: readonly Gstr1Line[];
}

/** Which of the four table-8 buckets a supply falls in. */
export type NilSupply =
  | 'inter_state_registered'
  | 'intra_state_registered'
  | 'inter_state_unregistered'
  | 'intra_state_unregistered';

export interface Gstr1NilRow {
  readonly supply: NilSupply;
  readonly nilRated: Paise;
  readonly exempt: Paise;
  readonly nonGst: Paise;
}

/** Table 12 row, net of notes. Quantity is thousandths of a unit. */
export interface Gstr1HsnRow {
  readonly hsn: string;
  readonly uqc: string;
  readonly quantity: number;
  readonly ratePercent: number;
  readonly value: TaxedValue;
}

/** Table 13 row. `code` is the portal's document-nature code (1, 1A, 2 ... 12). */
export interface Gstr1DocRow {
  readonly code: string;
  readonly nature: string;
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly cancelled: number;
  readonly net: number;
}

/**
 * Everything the engine knows about a GSTR-1. Sections the active mapper cannot express are
 * counted in `otherSections`, so a return is never presented as complete when it is not.
 */
export interface Gstr1Return {
  readonly gstin: string;
  readonly period: ReturnPeriod;
  readonly b2b: readonly Gstr1B2bParty[];
  readonly b2cl: readonly Gstr1B2clGroup[];
  readonly b2cs: readonly Gstr1B2csRow[];
  readonly creditDebitNotesRegistered: readonly Gstr1NoteParty[];
  readonly creditDebitNotesUnregistered: readonly Gstr1UnregisteredNote[];
  readonly exports: readonly Gstr1Export[];
  readonly nilExemptNonGst: readonly Gstr1NilRow[];
  readonly hsnB2b: readonly Gstr1HsnRow[];
  readonly hsnB2c: readonly Gstr1HsnRow[];
  readonly documentsIssued: readonly Gstr1DocRow[];
  /**
   * Sections the engine holds data for with no mapper coverage (advances, e-commerce, amendments):
   * name -> number of records. A non-empty entry becomes an export issue.
   */
  readonly otherSections: Readonly<Record<string, number>>;
}

// --- GSTR-3B ----------------------------------------------------------------

export interface PlaceOfSupplyRow {
  readonly placeOfSupply: string;
  readonly taxable: Paise;
  readonly igst: Paise;
}

export type ItcAvailableKind =
  'import_goods' | 'import_services' | 'reverse_charge' | 'isd' | 'other';
export type ItcReversedKind = 'rules_38_42_43_17_5' | 'other';
/** 4(D): (1) ITC reclaimed after an earlier 4(B)(2) reversal, (2) ineligible under s.16(4) or PoS. */
export type ItcIneligibleKind = 'reclaimed_after_reversal' | 'section_16_4_or_pos';

export interface Gstr3bReturn {
  readonly gstin: string;
  readonly period: ReturnPeriod;
  /** 3.1 */
  readonly outward: {
    /** (a) other than zero rated, nil rated and exempted. */
    readonly taxable: TaxedValue;
    /** (b) zero rated: IGST and cess only. */
    readonly zeroRated: { readonly taxable: Paise; readonly igst: Paise; readonly cess: Paise };
    /** (c) nil rated and exempted. */
    readonly nilExempt: Paise;
    /** (d) inward supplies liable to reverse charge. */
    readonly inwardReverseCharge: TaxedValue;
    /** (e) non-GST outward supplies. */
    readonly nonGst: Paise;
  };
  /** 3.1.1 (section 9(5)). Absent when the taxpayer has no such supplies. */
  readonly ecommerce?: {
    readonly ecoPaysTax: TaxedValue;
    readonly registeredViaEco: Paise;
  };
  /** 3.2: inter-state supplies shown in 3.1(a) to these recipient classes, per place of supply. */
  readonly interState: {
    readonly unregistered: readonly PlaceOfSupplyRow[];
    readonly composition: readonly PlaceOfSupplyRow[];
    readonly uin: readonly PlaceOfSupplyRow[];
  };
  /** 4 */
  readonly itc: {
    readonly available: Readonly<Record<ItcAvailableKind, TaxAmounts>>;
    readonly reversed: Readonly<Record<ItcReversedKind, TaxAmounts>>;
    readonly ineligible: Readonly<Record<ItcIneligibleKind, TaxAmounts>>;
  };
  /** 5: exempt, nil-rated and non-GST inward supplies. */
  readonly inwardExempt: {
    readonly gst: { readonly interState: Paise; readonly intraState: Paise };
    readonly nonGst: { readonly interState: Paise; readonly intraState: Paise };
  };
  /** 5.1: left undefined when the taxpayer has not entered interest / late fee. */
  readonly interest?: TaxAmounts;
  readonly lateFee?: { readonly cgst: Paise; readonly sgst: Paise };
}

// --- GSTR-9 -----------------------------------------------------------------

/** GSTR-9 Table 6 splits credit by what was bought: inputs, capital goods, input services. */
export type Gstr9ItcType = 'ip' | 'cg' | 'is';

export interface Gstr9Hsn {
  readonly hsn: string;
  readonly uqc: string;
  /** Thousandths of a unit. */
  readonly quantity: number;
  readonly ratePercent: number;
  readonly value: TaxedValue;
}

/** One head of Table 9: tax payable, and tax paid when the ledgers were imported. */
export interface Gstr9TaxHead {
  readonly payable: Paise;
  /** Null when no ledger covers the year: paid is unknown, not zero. */
  readonly paid: Paise | null;
}

/**
 * What BillBanao means by an annual return: the figures of Tables 4 to 9, 17 and 18 for one
 * GSTIN and financial year, in paise. Amounts are positive as the form shows them (credit notes
 * are listed in their own row and subtracted in the sub-total), and no portal key names appear
 * here: the versioned mapper does that.
 */
export interface Gstr9Return {
  readonly gstin: string;
  readonly fy: { readonly startYear: number; readonly endYear: number };
  /** Table 4: supplies on which tax is payable. */
  readonly t4: {
    readonly b2c: TaxedValue;
    readonly b2b: TaxedValue;
    readonly exp: TaxedValue;
    readonly sez: TaxedValue;
    readonly deemed: TaxedValue;
    readonly advances: TaxedValue;
    /** 4G: inward supplies on which tax is paid under reverse charge. */
    readonly inwardReverseCharge: TaxedValue;
    readonly ecommerce: TaxedValue;
    readonly creditNotes: TaxedValue;
    readonly debitNotes: TaxedValue;
    readonly amendmentsAdded: TaxedValue;
    readonly amendmentsReduced: TaxedValue;
  };
  /** Table 5: outward supplies on which tax is not payable. Values only. */
  readonly t5: {
    readonly zeroRated: Paise;
    readonly sez: Paise;
    readonly reverseCharge: Paise;
    readonly ecommerce: Paise;
    readonly exempt: Paise;
    readonly nilRated: Paise;
    readonly nonGst: Paise;
    readonly creditNotes: Paise;
    readonly debitNotes: Paise;
    readonly amendmentsAdded: Paise;
    readonly amendmentsReduced: Paise;
  };
  /** Table 6: credit availed through GSTR-3B. */
  readonly t6: {
    readonly total3b: TaxAmounts;
    readonly nonReverseCharge: Readonly<Record<Gstr9ItcType, TaxAmounts>>;
    readonly reverseChargeUnregistered: Readonly<Record<Gstr9ItcType, TaxAmounts>>;
    readonly reverseChargeRegistered: Readonly<Record<Gstr9ItcType, TaxAmounts>>;
    readonly importGoods: Readonly<Record<'ip' | 'cg', TaxAmounts>>;
    readonly importServices: TaxAmounts;
    readonly isd: TaxAmounts;
    readonly reclaimed: TaxAmounts;
  };
  /** Table 7: reversals. Only what the books can tell apart; the rest stays zero and is reported. */
  readonly t7: { readonly section17: TaxAmounts; readonly other: TaxAmounts };
  /** Table 9: tax payable and paid. */
  readonly t9: {
    readonly igst: Gstr9TaxHead;
    readonly cgst: Gstr9TaxHead;
    readonly sgst: Gstr9TaxHead;
    readonly cess: Gstr9TaxHead;
    readonly interest: Gstr9TaxHead;
    readonly lateFee: Gstr9TaxHead;
    readonly penalty: Gstr9TaxHead;
    readonly other: Gstr9TaxHead;
  };
  /** Table 17: outward supplies by HSN. */
  readonly hsnOutward: readonly Gstr9Hsn[];
  /** Table 18: inward supplies by HSN. */
  readonly hsnInward: readonly Gstr9Hsn[];
  /** Tables and rows this engine does not compute, so the file is never presented as complete. */
  readonly notComputed: readonly string[];
}
