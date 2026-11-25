/**
 * Amendments of outward details already reported in a filed GSTR-1 (decisions D12, D27). Pure.
 *
 * Two routes (Notification 12/2024-CT, Rule 59(1) proviso and 59(4A); GSTR-1 manual, tables 9A,
 * 9C, 10):
 *   - GSTR-1A, for the same period: open after the GSTR-1 is filed and until the GSTR-3B for that
 *     period is filed. A change of the recipient's GSTIN is not allowed in GSTR-1A (Form GSTR-1A,
 *     instruction 4).
 *   - A later GSTR-1 (9A for B2B / B2CL / exports, 9C for notes, 10 for B2CS), no later than the
 *     return for October after the financial year (s.37(3): 30 November, or the annual return if
 *     earlier), and never more than three years after the due date (s.37(5)).
 * Portal rules applied (GSTR-1 manual): the place of supply of a B2CL invoice or a B2CS row cannot
 * be amended. An invoice cannot move between B2B and B2CL by amendment; that is a credit note and a
 * new invoice. The tax on an amendment is the difference from what was reported.
 */
import { b2clThresholdPaise } from './classify.js';
import { lastClaimPeriod } from './itc-engine.js';
import { isGstinValid } from './gstin.js';
import type { Gstr1Line, TaxedValue } from './returns/model.js';

export const AMENDMENT_SECTIONS = ['b2b', 'b2cl', 'b2cs', 'exp', 'cdnr', 'cdnur'] as const;
export type AmendmentSection = (typeof AMENDMENT_SECTIONS)[number];
export type AmendmentRoute = 'gstr1a' | 'later_gstr1';

/** A reported document as the portal holds it (number-keyed sections). */
export interface AmendableDocument {
  readonly number: string;
  readonly date: string;
  /** Whole document value including tax, paise. */
  readonly value: number;
  readonly placeOfSupply: string;
  readonly recipientGstin?: string | null;
  readonly reverseCharge?: boolean;
  /** B2B / CDNR: regular, SEZ with or without payment, deemed export. */
  readonly recipientKind?: 'regular' | 'sez_with_payment' | 'sez_without_payment' | 'deemed_export';
  /** Exports: with or without payment of tax. */
  readonly exportType?: 'with_payment' | 'without_payment';
  /** Notes: credit or debit, and for unregistered notes the original type. */
  readonly noteKind?: 'credit' | 'debit';
  readonly unregisteredType?: 'b2cl' | 'export_with_payment' | 'export_without_payment';
  readonly lines: readonly Gstr1Line[];
}

/** A B2CS rate row (table 7), amended in table 10. */
export interface AmendableB2csRow {
  readonly placeOfSupply: string;
  readonly intraState: boolean;
  readonly ratePercent: number;
  readonly ecommerceGstin?: string | null;
  readonly value: TaxedValue;
}

export type AmendmentRecord = AmendableDocument | AmendableB2csRow;

export interface AmendmentContext {
  readonly section: AmendmentSection;
  readonly route: AmendmentRoute;
  readonly originalPeriod: string; // YYYY-MM
  readonly reportPeriod: string; // YYYY-MM
  readonly gstr1FiledForOriginal: boolean;
  readonly gstr3bFiledForOriginal: boolean;
  readonly reportReturnFiled: boolean;
  readonly today: string;
}

export interface AmendmentRefusal {
  readonly code: string;
  readonly message: string;
}

const isRow = (r: AmendmentRecord): r is AmendableB2csRow => 'ratePercent' in r;

export const ZERO_VALUE: TaxedValue = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };

export function totalOf(record: AmendmentRecord): TaxedValue {
  if (isRow(record)) return record.value;
  return record.lines.reduce(
    (s, l) => ({
      taxable: s.taxable + l.value.taxable,
      igst: s.igst + l.value.igst,
      cgst: s.cgst + l.value.cgst,
      sgst: s.sgst + l.value.sgst,
      cess: s.cess + l.value.cess,
    }),
    ZERO_VALUE,
  );
}

/**
 * Revised minus original: what the amendment adds to the liability of the return it is reported
 * in. A credit note's figures reduce liability, so its difference is negated.
 */
export function amendmentDifference(
  section: AmendmentSection,
  original: AmendmentRecord,
  revised: AmendmentRecord,
): TaxedValue {
  const o = totalOf(original);
  const r = totalOf(revised);
  const credit =
    (section === 'cdnr' || section === 'cdnur') &&
    !isRow(revised) &&
    (revised.noteKind ?? 'credit') === 'credit';
  const k = credit ? -1 : 1;
  return {
    taxable: k * (r.taxable - o.taxable),
    igst: k * (r.igst - o.igst),
    cgst: k * (r.cgst - o.cgst),
    sgst: k * (r.sgst - o.sgst),
    cess: k * (r.cess - o.cess),
  };
}

/** The last GSTR-1 period in which details of `originalPeriod` can still be amended (s.37(3)). */
export function lastAmendmentPeriod(originalPeriod: string): string {
  return lastClaimPeriod(`${originalPeriod}-01`);
}

export function amendmentRefusals(
  ctx: AmendmentContext,
  original: AmendmentRecord,
  revised: AmendmentRecord,
): AmendmentRefusal[] {
  const out: AmendmentRefusal[] = [];
  const refuse = (code: string, message: string) => out.push({ code, message });

  if (!ctx.gstr1FiledForOriginal) {
    refuse(
      'original_not_filed',
      'The GSTR-1 that reported this document is not filed yet, so there is nothing to amend: correct the document itself or prepare the GSTR-1 again.',
    );
  }
  if (ctx.reportReturnFiled) {
    refuse('report_return_filed', 'The return this amendment would be reported in is already filed.');
  }
  if (ctx.route === 'gstr1a') {
    if (ctx.reportPeriod !== ctx.originalPeriod) {
      refuse('gstr1a_other_period', 'GSTR-1A amends only its own period.');
    }
    if (ctx.gstr3bFiledForOriginal) {
      refuse(
        'gstr1a_after_3b',
        'GSTR-1A is open only until the GSTR-3B for the period is filed; amend in a later GSTR-1 instead.',
      );
    }
  } else {
    if (ctx.reportPeriod <= ctx.originalPeriod) {
      refuse('later_period_required', 'An amendment in GSTR-1 is reported in a later period than the original.');
    }
    const last = lastAmendmentPeriod(ctx.originalPeriod);
    if (ctx.reportPeriod > last) {
      refuse(
        'past_s37_3_limit',
        `Details of ${ctx.originalPeriod} can be amended no later than the GSTR-1 for ${last} (s.37(3): 30 November after the financial year).`,
      );
    }
  }

  if (isRow(original) || isRow(revised)) {
    if (ctx.section !== 'b2cs' || !isRow(original) || !isRow(revised)) {
      refuse('section_mismatch', 'Only a B2CS row is amended rate-wise.');
      return out;
    }
    if (original.placeOfSupply !== revised.placeOfSupply) {
      refuse('pos_not_amendable', 'The place of supply of a B2CS row cannot be amended (report the row under the right state instead).');
    }
    if (sameValue(original.value, revised.value) && original.ratePercent === revised.ratePercent) {
      refuse('no_change', 'The revised row is the same as the original.');
    }
    return out;
  }

  const gstinBefore = original.recipientGstin ?? null;
  const gstinAfter = revised.recipientGstin ?? null;
  if (ctx.section === 'b2b' || ctx.section === 'cdnr') {
    if (!gstinAfter || !isGstinValid(gstinAfter)) {
      refuse('recipient_gstin_required', 'A B2B invoice or a note to a registered buyer needs a valid recipient GSTIN.');
    }
    if (ctx.route === 'gstr1a' && gstinBefore !== gstinAfter) {
      refuse('gstin_change_not_in_1a', 'The recipient GSTIN cannot be changed in GSTR-1A; amend it in a later GSTR-1.');
    }
  } else if (gstinAfter) {
    refuse(
      'section_change',
      'An amendment cannot move an invoice from B2CL or exports to B2B: issue a credit note and a new invoice.',
    );
  }
  if (ctx.section === 'b2cl') {
    if (original.placeOfSupply !== revised.placeOfSupply) {
      refuse('pos_not_amendable', 'The place of supply of a B2CL invoice cannot be amended.');
    }
    if (revised.value <= b2clThresholdPaise(original.date)) {
      refuse(
        'below_b2cl_threshold',
        'A B2CL invoice must stay above the B2CL limit for its date; a smaller value is a B2CS row.',
      );
    }
  }
  if (revised.lines.length === 0) refuse('no_lines', 'The revised document has no lines.');
  if (
    original.number === revised.number &&
    original.date === revised.date &&
    original.value === revised.value &&
    original.placeOfSupply === revised.placeOfSupply &&
    gstinBefore === gstinAfter &&
    sameLines(original.lines, revised.lines)
  ) {
    refuse('no_change', 'The revised document is the same as the original.');
  }
  return out;
}

function sameValue(a: TaxedValue, b: TaxedValue): boolean {
  return (
    a.taxable === b.taxable && a.igst === b.igst && a.cgst === b.cgst && a.sgst === b.sgst && a.cess === b.cess
  );
}

function sameLines(a: readonly Gstr1Line[], b: readonly Gstr1Line[]): boolean {
  if (a.length !== b.length) return false;
  const key = (l: Gstr1Line) =>
    `${l.ratePercent}|${l.value.taxable}|${l.value.igst}|${l.value.cgst}|${l.value.sgst}|${l.value.cess}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Puts revised tax on the heads the supply actually takes. A client sends the tax for a line but
 * cannot always tell intra- from inter-State; the reported original can. Inter-State (IGST) when
 * the original carried IGST and the place of supply is unchanged, or when the place of supply
 * changes to another state than before (then the original's split no longer applies and the
 * client's split is kept). Intra-State otherwise: CGST and SGST in halves. Cess is left as sent.
 */
export function matchHeads(
  revised: readonly Gstr1Line[],
  original: readonly Gstr1Line[],
  revisedPos: string,
  originalPos: string,
): Gstr1Line[] {
  if (revisedPos !== originalPos) return [...revised];
  const tax = original.reduce(
    (s, l) => ({ igst: s.igst + l.value.igst, intra: s.intra + l.value.cgst + l.value.sgst }),
    { igst: 0, intra: 0 },
  );
  if (tax.igst === 0 && tax.intra === 0) return [...revised];
  const inter = tax.igst !== 0;
  return revised.map((l) => {
    const total = l.value.igst + l.value.cgst + l.value.sgst;
    const half = Math.trunc(total / 2);
    return {
      ratePercent: l.ratePercent,
      value: inter
        ? { ...l.value, igst: total, cgst: 0, sgst: 0 }
        : { ...l.value, igst: 0, cgst: total - half, sgst: half },
    };
  });
}
