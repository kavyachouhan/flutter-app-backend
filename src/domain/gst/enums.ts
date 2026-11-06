/**
 * GST vocabulary shared with the Flutter app (`packages/khata_domain/lib/src/gst/enums.dart`).
 * Frozen by docs/gst/A0A_ARCHITECTURE_FREEZE.md §7: the wire values are a contract, so a
 * value is only ever added (and the freeze document amended first), never renamed.
 *
 * Each enum is a readonly tuple plus the union type derived from it, so the same list
 * drives zod schemas, SQL CHECK constraints and the vector files.
 */

export const EINVOICE_EXEMPTION_CATEGORIES = [
  'none',
  'bank_nbfc_insurer',
  'gta',
  'passenger_transport',
  'multiplex_admission',
  'government_local_authority',
] as const;
export type EinvoiceExemptionCategory = (typeof EINVOICE_EXEMPTION_CATEGORIES)[number];

export const TURNOVER_SOURCES = ['declared', 'app_computed', 'portal_verified'] as const;
export type TurnoverSource = (typeof TURNOVER_SOURCES)[number];

export const REGISTRATION_KINDS = ['normal', 'casual', 'isd_reserved', 'tds_tcs_reserved'] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export const REGISTRATION_STATUSES = ['active', 'suspended', 'cancelled'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const TAXPAYER_SCHEMES = ['regular', 'composition'] as const;
export type TaxpayerScheme = (typeof TAXPAYER_SCHEMES)[number];

export const FILING_FREQUENCIES = ['monthly', 'qrmp'] as const;
export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];

export const OFFLINE_BACKDATE_POLICIES = ['audited_late_sync', 'strict_close'] as const;
export type OfflineBackdatePolicy = (typeof OFFLINE_BACKDATE_POLICIES)[number];

export const LOCK_LEVELS = ['gstr1_filed', 'gstr3b_filed'] as const;
export type LockLevel = (typeof LOCK_LEVELS)[number];

export const GST_TREATMENTS = [
  'registered_regular',
  'registered_composition',
  'unregistered',
  'consumer',
  'sez_unit',
  'sez_developer',
  'overseas',
  'uin_holder',
] as const;
export type GstTreatment = (typeof GST_TREATMENTS)[number];

/** Treatments identified by a GSTIN (UIN holders carry a separate `uin`). */
export const GSTIN_TREATMENTS: readonly GstTreatment[] = [
  'registered_regular',
  'registered_composition',
  'sez_unit',
  'sez_developer',
];

export const GST_DOCUMENT_TYPES = ['tax_invoice', 'bill_of_supply', 'invoice_cum_bill_of_supply'] as const;
export type GstDocumentType = (typeof GST_DOCUMENT_TYPES)[number];

export const SERIES_FAMILIES = [
  'outward_invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note_outward',
  'delivery_challan',
  'refund_voucher',
  'receipt_voucher',
  'payment_voucher',
  'rcm_self_invoice',
  'non_gst',
] as const;
export type SeriesFamily = (typeof SERIES_FAMILIES)[number];

/** Scenarios a client may send. `RESERVED_SUPPLY_SCENARIOS` are rejected until supported. */
export const SUPPLY_SCENARIOS = [
  'counter_sale',
  'delivered',
  'bill_to_ship_to',
  'goods_without_movement',
  'installation_at_site',
  'export_goods_with_payment',
  'export_goods_under_lut',
  'supply_to_sez',
  'services_general',
] as const;
export const RESERVED_SUPPLY_SCENARIOS = [
  'supply_from_sez',
  'cross_border_services',
  'deemed_export',
  'on_board_conveyance',
  'services_specific',
] as const;
/** Only rows migrated by 0039 may carry this; no client can send it. */
export const LEGACY_SUPPLY_SCENARIO = 'legacy_unclassified';
export type SupplyScenario =
  | (typeof SUPPLY_SCENARIOS)[number]
  | (typeof RESERVED_SUPPLY_SCENARIOS)[number]
  | typeof LEGACY_SUPPLY_SCENARIO;

export const POS_PROVISIONS = [
  'igst_10_1_a',
  'igst_10_1_b',
  'igst_10_1_c',
  'igst_10_1_d',
  'igst_11',
  'igst_7_5_b',
  'igst_12_2',
  'override',
  'legacy',
] as const;
export type PosProvision = (typeof POS_PROVISIONS)[number];

export const EINVOICE_REASONS = [
  'below_threshold',
  'turnover_unknown',
  'entity_exempt',
  'sez_unit',
  'not_a_supply_document',
  'composition',
  'document_kind_out_of_scope',
  'b2c_buyer',
  'uin_buyer_out_of_scope',
  'rcm_self_invoice_optional',
  'mandatory',
] as const;
export type EinvoiceReason = (typeof EINVOICE_REASONS)[number];

export const TAX_PAYABLE_BY = ['supplier', 'recipient'] as const;
export type TaxPayableBy = (typeof TAX_PAYABLE_BY)[number];

export const TAX_POINT_PROVISIONS = [
  'cgst_12_2',
  'cgst_12_3',
  'cgst_13_2',
  'cgst_13_3',
  'cgst_14',
  'supplier_reported',
  'customs_boe',
  'override',
  'legacy',
] as const;
export type TaxPointProvision = (typeof TAX_POINT_PROVISIONS)[number];

export const DOCUMENT_STATUSES = ['pending_irn', 'issued', 'void', 'withdrawn'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const IRN_STATES = [
  'not_required',
  'awaiting',
  'submitted_unknown',
  'rejected',
  'confirmed_absent',
  'registered',
  'cancelled',
] as const;
export type IrnState = (typeof IRN_STATES)[number];

/** The only (status, irn_state) pairs an outward GST document may hold (freeze §4.1). */
export const PERMITTED_STATUS_IRN_PAIRS: Readonly<Record<DocumentStatus, readonly IrnState[]>> = {
  issued: ['not_required', 'registered'],
  pending_irn: ['awaiting', 'submitted_unknown', 'rejected', 'confirmed_absent'],
  void: ['not_required', 'cancelled'],
  withdrawn: ['rejected', 'confirmed_absent'],
};

export const NUMBER_STATES = ['issued', 'cancelled', 'withdrawn', 'rejected_before_issue'] as const;
export type NumberState = (typeof NUMBER_STATES)[number];

export const REGISTRATION_RESOLUTIONS = ['resolved', 'non_gst', 'legacy_unresolved'] as const;
export type RegistrationResolution = (typeof REGISTRATION_RESOLUTIONS)[number];

export const SYNC_CLASSIFICATIONS = [
  'accepted',
  'late_sync_review',
  'rejected_after_lock_known',
  'quarantined',
  'server_created',
] as const;
export type SyncClassification = (typeof SYNC_CLASSIFICATIONS)[number];

export const SALES_CHANNELS = ['direct', 'marketplace'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const CORRECTION_REASONS = [
  'goods_return',
  'value_reduction',
  'excess_tax_charged',
  'post_supply_discount',
  'value_increase',
  'tax_undercharged',
] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

export const RECIPIENT_REVERSAL_STATUSES = ['verified', 'pending', 'unknown', 'not_applicable'] as const;
export type RecipientReversalStatus = (typeof RECIPIENT_REVERSAL_STATUSES)[number];

export const ITC_CATEGORIES = [
  'domestic_b2b',
  'rcm_registered_supplier',
  'rcm_unregistered_supplier',
  'rcm_import_of_services',
  'import_of_goods',
  'sez_inward',
  'isd',
] as const;
export type ItcCategory = (typeof ITC_CATEGORIES)[number];

export const ITC_STATUTORY_STATUSES = [
  'eligible',
  'pending_conditions',
  'ineligible_17_5',
  'ineligible_16_4',
  'ineligible_pos',
  'exception_review',
] as const;
export type ItcStatutoryStatus = (typeof ITC_STATUTORY_STATUSES)[number];

export const MATCH_2B_STATUSES = ['matched', 'mismatch', 'missing', 'not_applicable'] as const;
export type Match2bStatus = (typeof MATCH_2B_STATUSES)[number];

export const IMS_STATUSES = ['accepted', 'deemed_accepted', 'pending', 'rejected', 'not_applicable'] as const;
export type ImsStatus = (typeof IMS_STATUSES)[number];

export const ITC_MOVEMENT_KINDS = ['claim', 'reverse_permanent', 'reverse_temporary', 'reclaim', 'interest'] as const;
export type ItcMovementKind = (typeof ITC_MOVEMENT_KINDS)[number];

export const ITC_RULES = [
  'none',
  's17_5',
  'rule_37',
  'rule_37a',
  'rule_38',
  'rule_42',
  'rule_43',
  's16_4',
  'goods_not_received',
  'other',
] as const;
export type ItcRule = (typeof ITC_RULES)[number];

export const GSTR3B_TABLE4_LINES = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'd1', 'd2'] as const;
export type Gstr3bTable4Line = (typeof GSTR3B_TABLE4_LINES)[number];

/** Taxability of a supply in the rule set; matches the line `supply_category`. */
export const TAXABILITIES = ['taxable', 'nil_rated', 'exempt', 'non_gst'] as const;
export type Taxability = (typeof TAXABILITIES)[number];

export const RULE_SET_STATUSES = ['draft', 'published', 'withdrawn', 'legacy'] as const;
export type RuleSetStatus = (typeof RULE_SET_STATUSES)[number];

export const VERIFICATION_STATUSES = ['primary_verified', 'secondary_only'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const THRESHOLD_KEYS = [
  'einvoice_aato',
  'irn_30day_aato',
  'hsn_6digit_aato',
  'b2cl_invoice_value',
  'rule46_unregistered_taxable',
  'ewb_interstate_value',
  // Statutory day limits used by the time-of-supply resolver.
  'tos_service_invoice_days',
  'tos_rcm_goods_days',
  'tos_rcm_services_days',
] as const;
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

export const TAX_RATE_CONDITION_KEYS = ['unit_value_at_most', 'unit_value_above', 'manual_selection'] as const;
export type TaxRateConditionKey = (typeof TAX_RATE_CONDITION_KEYS)[number];
