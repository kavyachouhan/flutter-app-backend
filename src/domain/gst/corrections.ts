/**
 * How an issued document gets corrected (D27), shared with the Flutter app
 * (`packages/khata_domain/lib/src/gst/corrections.dart`). The way is chosen by what went wrong, not
 * by how long ago it happened: a GST credit note is not the universal fix.
 *
 * Statute behind the matrix: CGST Act s.15(3)(b), s.34, s.37(3), s.77; IGST Act s.19; Rule 59(4A).
 */
import { ValidationError } from '../../lib/errors.js';
import type { TaxLineInput } from '../tax/types.js';
import { statutoryFyStartYear } from './entity.js';

export const CORRECTION_SITUATIONS = [
  'wrong_details',
  'goods_returned',
  'value_too_high',
  'tax_too_high',
  'post_supply_discount',
  'commercial_credit',
  'value_increase',
  'tax_undercharged',
  'wrong_buyer_gstin',
  'wrong_place_of_supply',
  'reporting_error',
] as const;
export type CorrectionSituation = (typeof CORRECTION_SITUATIONS)[number];

export type CorrectionMechanism =
  | 'void_and_reissue'
  | 'irp_cancel_and_reissue'
  | 'return_credit_note'
  | 'value_credit_note'
  | 'financial_credit_note'
  | 'sales_debit_note'
  | 'fix_before_filing'
  | 'gstr1a_or_later_amendment'
  | 'later_gstr1_amendment'
  | 'choose_specific_reason';

export interface CorrectionFacts {
  readonly gstr1Filed: boolean;
  readonly gstr3bFiled: boolean;
  /** Registered with the IRP: it can then only be cancelled there, within its window. */
  readonly einvoiced: boolean;
  readonly withinIrpCancelWindow: boolean;
  readonly recipientRegistered: boolean;
  /** Post-supply discount only: null until the seller has asked. */
  readonly recipientWillReverseItc: boolean | null;
}

export type VoidRefusal = 'gstr1_filed' | 'einvoice_cancel_window_passed';

/** Why an issued document cannot simply be cancelled and issued again, or null when it can. */
export function voidRefusal(facts: Pick<CorrectionFacts, 'gstr1Filed' | 'einvoiced' | 'withinIrpCancelWindow'>): VoidRefusal | null {
  if (facts.gstr1Filed) return 'gstr1_filed';
  if (facts.einvoiced && !facts.withinIrpCancelWindow) return 'einvoice_cancel_window_passed';
  return null;
}

/** A filed return can only be corrected by amendment; 1A closes once GSTR-3B is filed (Rule 59(4A)). */
function amendmentRoute(facts: CorrectionFacts): CorrectionMechanism {
  return facts.gstr3bFiled ? 'later_gstr1_amendment' : 'gstr1a_or_later_amendment';
}

export function correctionRoute(situation: CorrectionSituation, facts: CorrectionFacts): CorrectionMechanism {
  const cancellable = voidRefusal(facts) === null;
  const reissue: CorrectionMechanism = facts.einvoiced ? 'irp_cancel_and_reissue' : 'void_and_reissue';
  switch (situation) {
    case 'wrong_details':
      return cancellable ? reissue : 'choose_specific_reason';
    case 'goods_returned':
      return 'return_credit_note';
    case 'value_too_high':
    case 'tax_too_high':
      return 'value_credit_note';
    case 'post_supply_discount':
      // s.15(3)(b), s.34(1) as amended: a GST credit note only if a registered recipient reverses
      // the credit; otherwise it is a financial credit note.
      return facts.recipientRegistered && facts.recipientWillReverseItc === false
        ? 'financial_credit_note'
        : 'value_credit_note';
    case 'commercial_credit':
      return 'financial_credit_note';
    case 'value_increase':
    case 'tax_undercharged':
      return 'sales_debit_note';
    case 'wrong_buyer_gstin':
      // GSTR-1A cannot change the recipient's GSTIN.
      return cancellable ? reissue : 'later_gstr1_amendment';
    case 'wrong_place_of_supply':
      return cancellable ? reissue : amendmentRoute(facts);
    case 'reporting_error':
      return facts.gstr1Filed ? amendmentRoute(facts) : 'fix_before_filing';
  }
}

/**
 * s.34(2): the last day a GST credit note may be declared for an invoice, 30 November after the
 * financial year of the supply ends. An annual return filed earlier ends it sooner.
 */
export function creditNoteLastDate(invoiceDate: string, annualReturnFiledOn: string | null = null): string {
  const limit = `${statutoryFyStartYear(invoiceDate) + 1}-11-30`;
  return annualReturnFiledOn !== null && annualReturnFiledOn < limit ? annualReturnFiledOn : limit;
}

export type AdjustmentKind = 'quantity' | 'value' | 'tax';

export interface SoldLineForAdjustment {
  readonly taxRatePercent: number;
  readonly cessRatePercent: number;
  readonly supplyCategory: TaxLineInput['supplyCategory'];
  readonly hsnCode: string | null;
  /** What has not yet been credited on this line, in paise of taxable value. */
  readonly remainingTaxable: number | null;
}

export interface AdjustmentRequest {
  readonly id: string;
  /** Taxable value in paise, exclusive of tax. */
  readonly amount: number;
  /** Only when correcting a wrong rate: the difference between the right rate and the charged one. */
  readonly differentialRatePercent?: number | null;
}

/**
 * A line of a note that changes value or tax with no goods moving. It goes through the same tax
 * engine as any other line, as one unit of the given value, at the rate of the line it adjusts. A
 * rate correction taxes the given value at the difference in rates, and does not reduce the value
 * still open on the line.
 */
export function adjustmentLine(sold: SoldLineForAdjustment, request: AdjustmentRequest): TaxLineInput {
  if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
    throw new ValidationError('An adjustment must be a positive amount.', { details: { lineId: request.id } });
  }
  const rate = request.differentialRatePercent ?? null;
  if (rate !== null && !(rate > 0)) {
    throw new ValidationError('A rate correction needs the difference between the rates.', {
      details: { lineId: request.id },
    });
  }
  if (rate === null && sold.remainingTaxable !== null && request.amount > sold.remainingTaxable) {
    throw new ValidationError('Cannot credit more than is left on the line.', {
      details: { lineId: request.id, remaining: sold.remainingTaxable, requested: request.amount },
    });
  }
  return {
    id: request.id,
    quantity: 1000,
    unitPrice: request.amount,
    taxRatePercent: rate ?? sold.taxRatePercent,
    cessRatePercent: rate === null ? sold.cessRatePercent : 0,
    supplyCategory: sold.supplyCategory,
    ...(sold.hsnCode ? { hsnCode: sold.hsnCode } : {}),
  };
}
