/**
 * Facts about the legal entity (one PAN) and what they decide: e-invoice applicability,
 * the IRN 30-day reporting window and the HSN digits required (D20, D23). Shared with
 * the Flutter app (`packages/khata_domain/lib/src/gst/entity.dart`). Nothing here is
 * stored; it is derived on demand so a corrected turnover changes every answer at once.
 *
 * Turnover thresholds are statutory and use the statutory financial year (April–March),
 * not the tenant's numbering year.
 */
import type {
  EinvoiceExemptionCategory,
  EinvoiceReason,
  GstTreatment,
  TurnoverSource,
} from './enums.js';
import { profileInForce, type RegistrationFacts } from './registration.js';
import { isInForce, thresholdValue, type GstRuleSet, type IsoDate } from './rule-set.js';
import type { SupplyType } from '../tax/types.js';

export interface TurnoverRecord {
  readonly fyStartYear: number;
  /** Paise; aggregate turnover under s.2(6), all GSTINs on the PAN. */
  readonly aggregateTurnover: number;
  readonly source: TurnoverSource;
}

export interface EntityFacts {
  readonly exemptionCategory: EinvoiceExemptionCategory;
  readonly turnover: readonly TurnoverRecord[];
}

/** First year e-invoice turnover is tested from (FY 2017-18). */
export const FIRST_GST_FY = 2017;

const SOURCE_PRECEDENCE: Readonly<Record<TurnoverSource, number>> = {
  portal_verified: 3,
  declared: 2,
  app_computed: 1,
};

export function statutoryFyStartYear(date: IsoDate): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

/** The turnover for a financial year by source precedence, or null when none is recorded. */
export function resolvedTurnover(entity: EntityFacts, fyStartYear: number): number | null {
  let best: TurnoverRecord | undefined;
  for (const r of entity.turnover) {
    if (r.fyStartYear !== fyStartYear) continue;
    if (best === undefined || SOURCE_PRECEDENCE[r.source] > SOURCE_PRECEDENCE[best.source]) best = r;
  }
  return best?.aggregateTurnover ?? null;
}

export type EinvoiceDocumentKind =
  | 'tax_invoice'
  | 'credit_note'
  | 'sales_debit_note'
  | 'bill_of_supply'
  | 'invoice_cum_bill_of_supply'
  | 'rcm_self_invoice';

export interface EinvoiceApplicabilityInput {
  readonly entity: EntityFacts;
  readonly registration: RegistrationFacts;
  readonly documentKind: EinvoiceDocumentKind;
  readonly buyerTreatment: GstTreatment;
  readonly supplyType: SupplyType;
  readonly documentDate: IsoDate;
  readonly ruleSet: GstRuleSet;
}

export interface EinvoiceApplicability {
  readonly mandatory: boolean;
  readonly reason: EinvoiceReason;
  /** 30 when the preceding FY's AATO is at or above the threshold; only set when mandatory. */
  readonly reportingWindowDays: 30 | null;
}

const NOT_MANDATORY = (reason: EinvoiceReason): EinvoiceApplicability => ({
  mandatory: false,
  reason,
  reportingWindowDays: null,
});

const E_INVOICE_KINDS: readonly EinvoiceDocumentKind[] = ['tax_invoice', 'credit_note', 'sales_debit_note'];

function isExport(supplyType: SupplyType): boolean {
  return supplyType === 'export_with_tax' || supplyType === 'export_without_tax';
}

/**
 * Whether a document must be registered with an IRP (freeze §1). Each test is a
 * statutory condition; the first that fails is the reason. A casual registration is
 * evaluated like a normal one. With no turnover recorded for any year the answer is
 * `turnover_unknown`, never a silent "below threshold".
 */
export function einvoiceApplicability(input: EinvoiceApplicabilityInput): EinvoiceApplicability {
  const { entity, registration, documentKind, buyerTreatment, supplyType, documentDate, ruleSet } = input;

  if (documentKind === 'rcm_self_invoice') return NOT_MANDATORY('rcm_self_invoice_optional');
  if (!E_INVOICE_KINDS.includes(documentKind)) return NOT_MANDATORY('document_kind_out_of_scope');

  if (registration.registrationKind === 'isd_reserved' || registration.registrationKind === 'tds_tcs_reserved') {
    return NOT_MANDATORY('not_a_supply_document');
  }
  if (registration.isSezUnit) return NOT_MANDATORY('sez_unit');
  if (profileInForce(registration, documentDate).taxpayerScheme === 'composition') {
    return NOT_MANDATORY('composition');
  }

  if (
    entity.exemptionCategory !== 'none' &&
    ruleSet.content.einvoiceExclusions.some(
      (e) => e.category === entity.exemptionCategory && isInForce(e, documentDate),
    )
  ) {
    return NOT_MANDATORY('entity_exempt');
  }

  if (buyerTreatment === 'uin_holder') return NOT_MANDATORY('uin_buyer_out_of_scope');
  const businessBuyer =
    buyerTreatment === 'registered_regular' ||
    buyerTreatment === 'registered_composition' ||
    buyerTreatment === 'sez_unit' ||
    buyerTreatment === 'sez_developer';
  if (!businessBuyer && !(buyerTreatment === 'overseas' && isExport(supplyType))) {
    return NOT_MANDATORY('b2c_buyer');
  }

  const fy = statutoryFyStartYear(documentDate);
  const threshold = thresholdValue(ruleSet, 'einvoice_aato', documentDate);
  let anyRecorded = false;
  let exceeded = false;
  for (let year = FIRST_GST_FY; year < fy; year++) {
    const turnover = resolvedTurnover(entity, year);
    if (turnover === null) continue;
    anyRecorded = true;
    if (turnover > threshold) exceeded = true;
  }
  if (!exceeded) return NOT_MANDATORY(anyRecorded ? 'below_threshold' : 'turnover_unknown');

  const preceding = resolvedTurnover(entity, fy - 1);
  const windowThreshold = thresholdValue(ruleSet, 'irn_30day_aato', documentDate);
  return {
    mandatory: true,
    reason: 'mandatory',
    reportingWindowDays: preceding !== null && preceding >= windowThreshold ? 30 : null,
  };
}

export interface HsnRequirement {
  readonly mandatory: boolean;
  /** Digits required when an HSN is given; for an optional B2C HSN it applies only if entered. */
  readonly minDigits: 4 | 6;
}

/**
 * HSN digits by the preceding FY's aggregate turnover (Notif. 78/2020-CT). Above the
 * threshold: 6 digits on every line. At or below it: 4 digits, mandatory on B2B lines
 * and optional on B2C. An unknown turnover is treated as at or below the threshold —
 * BillBanao's default segment — and onboarding asks for the figure.
 */
export function hsnRequirement(
  entity: EntityFacts,
  documentDate: IsoDate,
  buyerClass: 'b2b' | 'b2c',
  ruleSet: GstRuleSet,
): HsnRequirement {
  const preceding = resolvedTurnover(entity, statutoryFyStartYear(documentDate) - 1);
  const threshold = thresholdValue(ruleSet, 'hsn_6digit_aato', documentDate);
  if (preceding !== null && preceding > threshold) return { mandatory: true, minDigits: 6 };
  return { mandatory: buyerClass === 'b2b', minDigits: 4 };
}
