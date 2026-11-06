/**
 * Inputs for the GST contract vectors (A0b): GSTIN/UIN validation, rule-set selection
 * and evaluation, registration resolution and the entity derivations. The fixtures are
 * test data — `notificationRef: 'TEST'` everywhere — chosen to hit every branch, not a
 * copy of the real notified rates (those are A2 content, verified against CBIC text).
 */
import type { EinvoiceDocumentKind, EntityFacts } from '../../src/domain/gst/entity.js';
import type { GstTreatment } from '../../src/domain/gst/enums.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';
import type { RegistrationFacts } from '../../src/domain/gst/registration.js';
import type { TaxPointFacts, TaxPointKind } from '../../src/domain/gst/time-of-supply.js';
import type { GstRuleSet, GstRuleSetContent, LineRateInput } from '../../src/domain/gst/rule-set.js';
import type { SupplyType } from '../../src/domain/tax/types.js';
import { Rng } from './prng.js';

const ref = { notificationRef: 'TEST', verificationStatus: 'primary_verified' } as const;
const span = (effectiveFrom: string, effectiveTo: string | null = null) => ({ effectiveFrom, effectiveTo });

const CRORE = 10_000_000 * 100; // ₹1 crore in paise
const LAKH = 100_000 * 100;

function content(variant: 'base' | 'gst2' | 'nov26' | 'nov26fix'): GstRuleSetContent {
  const gst2 = variant !== 'base';
  const nov = variant === 'nov26' || variant === 'nov26fix';
  return {
    allowedRates: [
      ...[0, 0.25, 3, 5, 18].map((ratePercent) => ({ ratePercent, ...span('2017-07-01'), ...ref })),
      ...[12, 28].map((ratePercent) => ({ ratePercent, ...span('2017-07-01', '2025-09-22'), ...ref })),
      ...(gst2 ? [{ ratePercent: 40, ...span('2025-09-22'), ...ref }] : []),
    ],
    taxRates: [
      { id: 'hsn-1006', scope: { kind: 'hsn', codePrefixes: ['1006'] }, taxability: 'taxable', ratePercent: 5, condition: null, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-0401-nil', scope: { kind: 'hsn', codePrefixes: ['0401'] }, taxability: 'nil_rated', ratePercent: null, condition: null, exemptionBasis: 'TEST-NIL', rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-61-low', scope: { kind: 'hsn', codePrefixes: ['61'] }, taxability: 'taxable', ratePercent: 5, condition: { key: 'unit_value_at_most', value: 2_500_00, description: 'Sale value up to ₹2,500 per piece' }, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-61-high', scope: { kind: 'hsn', codePrefixes: ['61'] }, taxability: 'taxable', ratePercent: gst2 ? 18 : 12, condition: { key: 'unit_value_above', value: 2_500_00, description: 'Sale value above ₹2,500 per piece' }, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-84', scope: { kind: 'hsn', codePrefixes: ['84'], excludePrefixes: ['8432'] }, taxability: 'taxable', ratePercent: 18, condition: null, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-8432', scope: { kind: 'hsn', codePrefixes: ['8432'] }, taxability: 'taxable', ratePercent: gst2 ? 5 : 12, condition: null, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-2106-a', scope: { kind: 'hsn', codePrefixes: ['2106'] }, taxability: 'taxable', ratePercent: 5, condition: { key: 'manual_selection', value: null, description: 'Choose by product description' }, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-2106-b', scope: { kind: 'hsn', codePrefixes: ['2106'] }, taxability: 'taxable', ratePercent: 18, condition: { key: 'manual_selection', value: null, description: 'Choose by product description' }, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'hsn-8703-old', scope: { kind: 'hsn', codePrefixes: ['8703'] }, taxability: 'taxable', ratePercent: 28, condition: null, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01', '2025-09-22'), ...ref },
      ...(gst2
        ? [{ id: 'hsn-8703-new', scope: { kind: 'hsn' as const, codePrefixes: ['8703'] }, taxability: 'taxable' as const, ratePercent: 40, condition: null, exemptionBasis: null, rcmCategoryCode: null, ...span('2025-09-22'), ...ref }]
        : []),
      ...(nov
        ? [{ id: 'hsn-4012', scope: { kind: 'hsn' as const, codePrefixes: ['4012'] }, taxability: 'taxable' as const, ratePercent: variant === 'nov26fix' ? 5 : 18, condition: null, exemptionBasis: null, rcmCategoryCode: null, ...span('2026-11-01'), ...ref }]
        : []),
      { id: 'sac-9954', scope: { kind: 'sac', codePrefixes: ['9954'] }, taxability: 'taxable', ratePercent: 18, condition: null, exemptionBasis: null, rcmCategoryCode: null, ...span('2017-07-01'), ...ref },
      { id: 'sac-9965-gta', scope: { kind: 'sac', codePrefixes: ['9965'] }, taxability: 'taxable', ratePercent: 5, condition: null, exemptionBasis: null, rcmCategoryCode: 'gta', ...span('2017-07-01'), ...ref },
    ],
    cess: {
      allowedUntil: '2026-01-31',
      ...ref,
      history: [
        { scope: { kind: 'hsn', codePrefixes: ['2402'] }, adValoremPercent: 5, specificPerUnit: { amountPaise: 2_076, uqc: 'NOS' }, compound: 'sum', ...span('2017-07-01', '2026-02-01'), ...ref },
      ],
    },
    thresholds: [
      { key: 'einvoice_aato', value: 5 * CRORE, ...span('2023-08-01'), ...ref },
      { key: 'einvoice_aato', value: 10 * CRORE, ...span('2022-10-01', '2023-08-01'), ...ref },
      { key: 'irn_30day_aato', value: 10 * CRORE, ...span('2025-04-01'), ...ref },
      { key: 'irn_30day_aato', value: 100 * CRORE, ...span('2023-11-01', '2025-04-01'), ...ref },
      { key: 'hsn_6digit_aato', value: 5 * CRORE, ...span('2021-04-01'), ...ref },
      { key: 'b2cl_invoice_value', value: 1 * LAKH, ...span('2024-08-01'), ...ref },
      { key: 'b2cl_invoice_value', value: 2.5 * LAKH, ...span('2017-07-01', '2024-08-01'), ...ref },
      { key: 'rule46_unregistered_taxable', value: 50_000 * 100, ...span('2017-07-01'), ...ref },
      { key: 'ewb_interstate_value', value: 50_000 * 100, ...span('2018-04-01'), ...ref },
      { key: 'tos_service_invoice_days', value: 30, ...span('2017-07-01'), ...ref },
      { key: 'tos_rcm_goods_days', value: 30, ...span('2017-07-01'), ...ref },
      { key: 'tos_rcm_services_days', value: 60, ...span('2017-07-01'), ...ref },
    ],
    stateCodes: [
      { code: '04', name: 'Chandigarh', isUnionTerritoryWithoutLegislature: true },
      { code: '27', name: 'Maharashtra', isUnionTerritoryWithoutLegislature: false },
      { code: '29', name: 'Karnataka', isUnionTerritoryWithoutLegislature: false },
      { code: '96', name: 'Foreign Country', isUnionTerritoryWithoutLegislature: false },
    ],
    uqc: [
      { code: 'NOS', description: 'Numbers', unitAliases: ['pc', 'pcs', 'nos'] },
      { code: 'KGS', description: 'Kilograms', unitAliases: ['kg'] },
    ],
    rcmCategories: [
      { code: 'gta', description: 'Goods transport agency services', direction: 'services', recipientMustBe: 'registered', ...span('2017-07-01'), ...ref },
    ],
    blockedCredits: [
      { code: 'motor_vehicles', description: 'Motor vehicles for passenger transport', section: '17(5)(a)', ...span('2017-07-01'), ...ref },
    ],
    einvoiceExclusions: (['bank_nbfc_insurer', 'gta', 'passenger_transport', 'multiplex_admission'] as const).map(
      (category) => ({ category, ...span('2020-10-01'), ...ref }),
    ),
    validationRules: [
      { id: 'hsn_rate_mismatch', returnType: 'sales', check: 'hsn_rate_mismatch', enforcement: 'warn', ...span('2017-07-01'), ...ref },
      { id: 'ecrrs_reclaim_limit', returnType: 'gstr3b', check: 'ecrrs_reclaim_limit', enforcement: nov ? 'block' : 'warn', ...span('2025-12-29'), ...ref },
    ],
    gstr1aAmendableFields: { b2b: ['place_of_supply', 'taxable_value', 'rate'] },
    ewbIntraStateThresholds: [{ stateCode: '19', value: 50_000 * 100, ...span('2026-06-01'), ...ref }],
  };
}

const version = (
  effectiveFrom: string,
  revision: number,
  status: GstRuleSet['status'],
  variant: Parameters<typeof content>[0],
  supersedes: string | null = null,
): GstRuleSet => ({
  version: `${effectiveFrom}.${revision}`,
  effectiveFrom,
  revision,
  supersedes,
  status,
  content: content(variant),
});

const legacyContent = (): GstRuleSetContent => ({
  ...content('base'),
  allowedRates: [],
  taxRates: [],
  thresholds: [],
  validationRules: [],
});

export const RULE_SETS: readonly GstRuleSet[] = [
  { version: 'legacy', effectiveFrom: '2017-07-01', revision: 1, supersedes: null, status: 'legacy', content: legacyContent() },
  version('2017-07-01', 1, 'published', 'base'),
  version('2025-09-22', 1, 'published', 'gst2'),
  version('2026-10-15', 1, 'withdrawn', 'gst2'),
  version('2026-11-01', 1, 'published', 'nov26'),
  version('2026-11-01', 2, 'published', 'nov26fix', '2026-11-01.1'),
  version('2026-12-01', 1, 'draft', 'nov26fix'),
];

// --- GSTIN -----------------------------------------------------------------

export interface GstinCase {
  readonly name: string;
  readonly op: 'gstinProblem' | 'isUinFormatValid' | 'normaliseGstin' | 'gstinMatchesState';
  readonly input: { readonly value: string; readonly stateCode?: string };
}

function withCheck(first14: string): string {
  return first14 + gstinCheckCharacter(first14);
}

export function gstinCases(): GstinCase[] {
  const p = (name: string, value: string): GstinCase => ({ name, op: 'gstinProblem', input: { value } });
  const cases: GstinCase[] = [
    p('a published valid GSTIN (Maharashtra)', '27AAPFU0939F1ZV'),
    p('a published valid GSTIN (Karnataka)', '29AAGCB7383J1Z4'),
    p('a published valid GSTIN (Tamil Nadu)', '33AAACH7409R1Z8'),
    p('wrong check character', '27AAPFU0939F1ZW'),
    p('lower case is not normalised by the validator', '27aapfu0939f1zv'),
    p('fourteen characters', '27AAPFU0939F1Z'),
    p('sixteen characters', '27AAPFU0939F1ZVV'),
    p('14th character must be Z', '27AAPFU0939F1AV'),
    p('13th character may not be 0', withCheck('27AAPFU0939F0Z')),
    p('state code 00', withCheck('00AAPFU0939F1Z')),
    p('state code 39 is not a GST state', withCheck('39AAPFU0939F1Z')),
    p('state code 96 is a place of supply, not a registration', withCheck('96AAPFU0939F1Z')),
    p('state code 97 (Other Territory)', withCheck('97AAPFU0939F1Z')),
    p('state code 99 (Centre Jurisdiction)', withCheck('99AAPFU0939F1Z')),
    p('state code 38 (Ladakh)', withCheck('38AAPFU0939F1Z')),
    p('retired state code 28 still validates', withCheck('28AAPFU0939F1Z')),
    p('PAN digits where letters belong', '2712345678901ZV'),
    p('empty string', ''),
    { name: 'UIN: fifteen upper-case alphanumerics', op: 'isUinFormatValid', input: { value: '0717UNO00157UNO' } },
    { name: 'UIN: lower case rejected', op: 'isUinFormatValid', input: { value: '0717uno00157uno' } },
    { name: 'UIN: too short', op: 'isUinFormatValid', input: { value: '0717UNO00157UN' } },
    { name: 'normalise strips spaces and upper-cases', op: 'normaliseGstin', input: { value: ' 27aapfu 0939f1zv ' } },
    { name: 'prefix matches declared state', op: 'gstinMatchesState', input: { value: '27AAPFU0939F1ZV', stateCode: '27' } },
    { name: 'prefix differs from declared state', op: 'gstinMatchesState', input: { value: '27AAPFU0939F1ZV', stateCode: '29' } },
  ];
  // Random sweep: valid GSTINs built from random PANs, and the same with one character changed.
  const rng = new Rng(0x6a57);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const alnum = '0123456789' + letters;
  for (let i = 0; i < 60; i++) {
    const state = String(rng.pick([1, 4, 7, 9, 19, 24, 27, 29, 32, 33, 36, 37, 38, 97, 99])).padStart(2, '0');
    let pan = '';
    for (let k = 0; k < 5; k++) pan += rng.pick([...letters]);
    for (let k = 0; k < 4; k++) pan += String(rng.int(0, 9));
    pan += rng.pick([...letters]);
    const entity = rng.pick([...'123456789ABCDEFGHJKLMNPQRSTUVWXYZ']);
    const valid = withCheck(`${state}${pan}${entity}Z`);
    cases.push(p(`sweep ${i}: valid`, valid));
    const pos = rng.int(2, 13);
    const replacement = rng.pick([...alnum].filter((ch) => ch !== valid.charAt(pos)));
    cases.push(p(`sweep ${i}: one character changed`, valid.slice(0, pos) + replacement + valid.slice(pos + 1)));
  }
  return cases;
}

// --- Rule set ----------------------------------------------------------------

export type RuleSetCase =
  | { readonly name: string; readonly op: 'selectRuleSet'; readonly input: { readonly date: string } }
  | { readonly name: string; readonly op: 'thresholdValue'; readonly input: { readonly version: string; readonly key: string; readonly date: string } }
  | { readonly name: string; readonly op: 'isRateAllowed'; readonly input: { readonly version: string; readonly ratePercent: number; readonly date: string } }
  | { readonly name: string; readonly op: 'isCessAllowed'; readonly input: { readonly version: string; readonly date: string } }
  | { readonly name: string; readonly op: 'validationEnforcement'; readonly input: { readonly version: string; readonly id: string; readonly date: string } }
  | { readonly name: string; readonly op: 'ratesFor'; readonly input: { readonly version: string; readonly kind: 'hsn' | 'sac'; readonly code: string; readonly date: string } }
  | { readonly name: string; readonly op: 'checkLineRate'; readonly input: { readonly version: string; readonly line: LineRateInput; readonly date: string } };

export function ruleSetCases(): RuleSetCase[] {
  const sel = (name: string, date: string): RuleSetCase => ({ name, op: 'selectRuleSet', input: { date } });
  const V = '2025-09-22.1';
  const line = (code: string | null, supplyCategory: LineRateInput['supplyCategory'], ratePercent: number, unitValue: number | null = null, kind: 'hsn' | 'sac' = 'hsn'): LineRateInput =>
    ({ kind, code, supplyCategory, ratePercent, unitValue });
  return [
    sel('before any published version', '2017-06-30'),
    sel('first day of the base version', '2017-07-01'),
    sel('day before GST 2.0', '2025-09-21'),
    sel('GST 2.0 day', '2025-09-22'),
    sel('a withdrawn future version is never selected', '2026-10-20'),
    sel('the highest revision of a group wins', '2026-11-01'),
    sel('a draft is never selected', '2026-12-15'),
    { name: 'threshold: e-invoice ₹5 cr after Aug 2023', op: 'thresholdValue', input: { version: V, key: 'einvoice_aato', date: '2025-10-01' } },
    { name: 'threshold: e-invoice ₹10 cr before Aug 2023', op: 'thresholdValue', input: { version: V, key: 'einvoice_aato', date: '2023-07-31' } },
    { name: 'threshold: B2CL changes on 1 Aug 2024', op: 'thresholdValue', input: { version: V, key: 'b2cl_invoice_value', date: '2024-07-31' } },
    { name: 'threshold: B2CL ₹1 lakh', op: 'thresholdValue', input: { version: V, key: 'b2cl_invoice_value', date: '2024-08-01' } },
    { name: 'threshold: none in force is an error', op: 'thresholdValue', input: { version: V, key: 'irn_30day_aato', date: '2023-01-01' } },
    { name: 'threshold: the legacy label cannot be evaluated', op: 'thresholdValue', input: { version: 'legacy', key: 'einvoice_aato', date: '2025-10-01' } },
    { name: 'rate 12 allowed before GST 2.0', op: 'isRateAllowed', input: { version: V, ratePercent: 12, date: '2025-09-21' } },
    { name: 'rate 12 not allowed from GST 2.0', op: 'isRateAllowed', input: { version: V, ratePercent: 12, date: '2025-09-22' } },
    { name: 'rate 40 allowed from GST 2.0', op: 'isRateAllowed', input: { version: V, ratePercent: 40, date: '2025-09-22' } },
    { name: 'rate 0.25 allowed', op: 'isRateAllowed', input: { version: V, ratePercent: 0.25, date: '2025-10-01' } },
    { name: 'cess allowed on its last day', op: 'isCessAllowed', input: { version: V, date: '2026-01-31' } },
    { name: 'cess not allowed after', op: 'isCessAllowed', input: { version: V, date: '2026-02-01' } },
    { name: 'validation rule switched on as warn', op: 'validationEnforcement', input: { version: V, id: 'hsn_rate_mismatch', date: '2025-10-01' } },
    { name: 'validation rule not yet in force', op: 'validationEnforcement', input: { version: V, id: 'ecrrs_reclaim_limit', date: '2025-12-01' } },
    { name: 'validation rule flipped to block by a later version', op: 'validationEnforcement', input: { version: '2026-11-01.2', id: 'ecrrs_reclaim_limit', date: '2026-11-02' } },
    { name: 'validation rule not defined', op: 'validationEnforcement', input: { version: V, id: 'no_such_rule', date: '2025-10-01' } },
    { name: 'ratesFor: exact 4-digit HSN', op: 'ratesFor', input: { version: V, kind: 'hsn', code: '10063020', date: '2025-10-01' } },
    { name: 'ratesFor: two conditional candidates', op: 'ratesFor', input: { version: V, kind: 'hsn', code: '6109', date: '2025-10-01' } },
    { name: 'ratesFor: carve-out goes to the longer scope', op: 'ratesFor', input: { version: V, kind: 'hsn', code: '84321000', date: '2025-10-01' } },
    { name: 'ratesFor: broad chapter scope', op: 'ratesFor', input: { version: V, kind: 'hsn', code: '847130', date: '2025-10-01' } },
    { name: 'ratesFor: dated entries switch on GST 2.0', op: 'ratesFor', input: { version: V, kind: 'hsn', code: '8703', date: '2025-09-21' } },
    { name: 'ratesFor: dated entries after GST 2.0', op: 'ratesFor', input: { version: V, kind: 'hsn', code: '8703', date: '2025-09-22' } },
    { name: 'ratesFor: SAC does not match an HSN scope', op: 'ratesFor', input: { version: V, kind: 'sac', code: '1006', date: '2025-10-01' } },
    { name: 'ratesFor: SAC scope', op: 'ratesFor', input: { version: V, kind: 'sac', code: '995411', date: '2025-10-01' } },
    { name: 'ratesFor: no coverage', op: 'ratesFor', input: { version: V, kind: 'hsn', code: '9999', date: '2025-10-01' } },
    { name: 'ratesFor: corrected revision changes the rate', op: 'ratesFor', input: { version: '2026-11-01.2', kind: 'hsn', code: '4012', date: '2026-11-05' } },
    { name: 'check: matching rate', op: 'checkLineRate', input: { version: V, line: line('1006', 'taxable', 5), date: '2025-10-01' } },
    { name: 'check: wrong rate', op: 'checkLineRate', input: { version: V, line: line('1006', 'taxable', 18), date: '2025-10-01' } },
    { name: 'check: condition at the boundary (at most)', op: 'checkLineRate', input: { version: V, line: line('6109', 'taxable', 5, 2_500_00), date: '2025-10-01' } },
    { name: 'check: condition above the boundary', op: 'checkLineRate', input: { version: V, line: line('6109', 'taxable', 18, 2_500_01), date: '2025-10-01' } },
    { name: 'check: low rate on a high-value piece', op: 'checkLineRate', input: { version: V, line: line('6109', 'taxable', 5, 3_000_00), date: '2025-10-01' } },
    { name: 'check: unknown unit value fails a value condition', op: 'checkLineRate', input: { version: V, line: line('6109', 'taxable', 5), date: '2025-10-01' } },
    { name: 'check: manual selection accepts either candidate', op: 'checkLineRate', input: { version: V, line: line('2106', 'taxable', 18), date: '2025-10-01' } },
    { name: 'check: nil-rated matches on taxability, catalogue rate ignored', op: 'checkLineRate', input: { version: V, line: line('0401', 'nil_rated', 5), date: '2025-10-01' } },
    { name: 'check: taxable where the rule set says nil', op: 'checkLineRate', input: { version: V, line: line('0401', 'taxable', 5), date: '2025-10-01' } },
    { name: 'check: no HSN, notified slab', op: 'checkLineRate', input: { version: V, line: line(null, 'taxable', 18), date: '2025-10-01' } },
    { name: 'check: no HSN, retired slab', op: 'checkLineRate', input: { version: V, line: line(null, 'taxable', 12), date: '2025-10-01' } },
    { name: 'check: uncovered HSN, exempt line', op: 'checkLineRate', input: { version: V, line: line('9999', 'exempt', 0), date: '2025-10-01' } },
    { name: 'check: SAC line', op: 'checkLineRate', input: { version: V, line: line('995411', 'taxable', 18, null, 'sac'), date: '2025-10-01' } },
  ];
}

// --- Registration --------------------------------------------------------------

const profile = (
  effectiveFrom: string,
  effectiveTo: string | null,
  taxpayerScheme: 'regular' | 'composition',
  filingFrequency: 'monthly' | 'qrmp' = 'monthly',
) => ({
  effectiveFrom,
  effectiveTo,
  taxpayerScheme,
  compositionCategory: taxpayerScheme === 'composition' ? 'trader' : null,
  compositionRatePercent: taxpayerScheme === 'composition' ? 1 : null,
  filingFrequency,
});

const registration = (over: Partial<RegistrationFacts> & Pick<RegistrationFacts, 'id'>): RegistrationFacts => ({
  gstin: '27AAPFU0939F1ZV',
  stateCode: '27',
  registrationKind: 'normal',
  isSezUnit: false,
  isSezDeveloper: false,
  status: 'active',
  effectiveFrom: '2017-07-01',
  effectiveTo: null,
  profiles: [profile('2017-07-01', null, 'regular')],
  ...over,
});

export const REGISTRATIONS: readonly RegistrationFacts[] = [
  registration({
    id: 'reg-switches',
    profiles: [
      profile('2017-07-01', '2025-04-01', 'regular', 'monthly'),
      profile('2025-04-01', '2026-04-01', 'regular', 'qrmp'),
      profile('2026-04-01', null, 'composition', 'qrmp'),
    ],
  }),
  registration({ id: 'reg-casual', registrationKind: 'casual', effectiveFrom: '2026-10-01', effectiveTo: '2026-12-30', profiles: [profile('2026-10-01', '2026-12-30', 'regular')] }),
  registration({ id: 'reg-sez-unit', isSezUnit: true }),
  registration({ id: 'reg-sez-developer', isSezDeveloper: true }),
  registration({ id: 'reg-isd', registrationKind: 'isd_reserved' }),
  registration({ id: 'reg-cancelled', status: 'cancelled', effectiveFrom: '2024-01-01', effectiveTo: '2026-01-01', profiles: [profile('2024-01-01', '2026-01-01', 'regular')] }),
  registration({ id: 'reg-gap', profiles: [profile('2017-07-01', '2020-04-01', 'regular'), profile('2020-07-01', null, 'regular')] }),
  registration({ id: 'reg-normal' }),
];

export interface RegistrationCase {
  readonly name: string;
  readonly op: 'profileInForce' | 'taxModeFor' | 'isRegistrationInForce';
  readonly input: { readonly registrationId: string | null; readonly date: string };
}

export function registrationCases(): RegistrationCase[] {
  const c = (name: string, op: RegistrationCase['op'], registrationId: string | null, date: string): RegistrationCase =>
    ({ name, op, input: { registrationId, date } });
  return [
    c('profile: first range', 'profileInForce', 'reg-switches', '2025-03-31'),
    c('profile: half-open boundary belongs to the next range', 'profileInForce', 'reg-switches', '2025-04-01'),
    c('profile: composition from FY 2026-27', 'profileInForce', 'reg-switches', '2026-04-01'),
    c('profile: gap is an error', 'profileInForce', 'reg-gap', '2020-05-15'),
    c('tax mode: regular', 'taxModeFor', 'reg-switches', '2026-03-31'),
    c('tax mode: composition', 'taxModeFor', 'reg-switches', '2026-04-01'),
    c('tax mode: no registration', 'taxModeFor', null, '2026-04-01'),
    c('tax mode: before the registration began', 'taxModeFor', 'reg-cancelled', '2023-12-31'),
    c('tax mode: last day before cancellation', 'taxModeFor', 'reg-cancelled', '2025-12-31'),
    c('tax mode: on the cancellation date (exclusive end)', 'taxModeFor', 'reg-cancelled', '2026-01-01'),
    c('tax mode: casual registration in its window', 'taxModeFor', 'reg-casual', '2026-11-05'),
    c('in force: casual after its window', 'isRegistrationInForce', 'reg-casual', '2026-12-30'),
    c('in force: open-ended', 'isRegistrationInForce', 'reg-normal', '2030-01-01'),
  ];
}

// --- Entity ---------------------------------------------------------------------

export const ENTITIES: Readonly<Record<string, EntityFacts>> = {
  'big-and-growing': {
    exemptionCategory: 'none',
    turnover: [
      { fyStartYear: 2022, aggregateTurnover: 6 * CRORE, source: 'declared' },
      { fyStartYear: 2025, aggregateTurnover: 12 * CRORE, source: 'portal_verified' },
    ],
  },
  'crossed-once-long-ago': {
    exemptionCategory: 'none',
    turnover: [
      { fyStartYear: 2019, aggregateTurnover: 5 * CRORE + 1, source: 'declared' },
      { fyStartYear: 2025, aggregateTurnover: 2 * CRORE, source: 'declared' },
    ],
  },
  'exactly-five-crore': {
    exemptionCategory: 'none',
    turnover: [{ fyStartYear: 2025, aggregateTurnover: 5 * CRORE, source: 'declared' }],
  },
  small: {
    exemptionCategory: 'none',
    turnover: [{ fyStartYear: 2025, aggregateTurnover: 80 * LAKH, source: 'declared' }],
  },
  unknown: { exemptionCategory: 'none', turnover: [] },
  'precedence': {
    exemptionCategory: 'none',
    turnover: [
      { fyStartYear: 2025, aggregateTurnover: 6 * CRORE, source: 'app_computed' },
      { fyStartYear: 2025, aggregateTurnover: 4 * CRORE, source: 'declared' },
    ],
  },
  gta: {
    exemptionCategory: 'gta',
    turnover: [{ fyStartYear: 2025, aggregateTurnover: 50 * CRORE, source: 'declared' }],
  },
  'govt-not-in-rule-set': {
    exemptionCategory: 'government_local_authority',
    turnover: [{ fyStartYear: 2025, aggregateTurnover: 50 * CRORE, source: 'declared' }],
  },
};

export type EntityCase =
  | { readonly name: string; readonly op: 'statutoryFyStartYear'; readonly input: { readonly date: string } }
  | { readonly name: string; readonly op: 'resolvedTurnover'; readonly input: { readonly entity: string; readonly fyStartYear: number } }
  | {
      readonly name: string;
      readonly op: 'einvoiceApplicability';
      readonly input: {
        readonly entity: string;
        readonly registrationId: string;
        readonly documentKind: EinvoiceDocumentKind;
        readonly buyerTreatment: GstTreatment;
        readonly supplyType: SupplyType;
        readonly documentDate: string;
        readonly ruleSetVersion: string;
      };
    }
  | {
      readonly name: string;
      readonly op: 'hsnRequirement';
      readonly input: { readonly entity: string; readonly documentDate: string; readonly buyerClass: 'b2b' | 'b2c'; readonly ruleSetVersion: string };
    };

export function entityCases(): EntityCase[] {
  const V = '2025-09-22.1';
  const e = (
    name: string,
    over: Partial<Extract<EntityCase, { op: 'einvoiceApplicability' }>['input']> = {},
  ): EntityCase => ({
    name,
    op: 'einvoiceApplicability',
    input: {
      entity: 'big-and-growing',
      registrationId: 'reg-normal',
      documentKind: 'tax_invoice',
      buyerTreatment: 'registered_regular',
      supplyType: 'intra_state',
      documentDate: '2026-11-05',
      ruleSetVersion: V,
      ...over,
    },
  });
  const h = (name: string, entity: string, buyerClass: 'b2b' | 'b2c', documentDate = '2026-11-05'): EntityCase =>
    ({ name, op: 'hsnRequirement', input: { entity, documentDate, buyerClass, ruleSetVersion: V } });
  return [
    { name: 'FY: 31 March belongs to the earlier year', op: 'statutoryFyStartYear', input: { date: '2026-03-31' } },
    { name: 'FY: 1 April starts a new year', op: 'statutoryFyStartYear', input: { date: '2026-04-01' } },
    { name: 'turnover: portal_verified beats declared', op: 'resolvedTurnover', input: { entity: 'big-and-growing', fyStartYear: 2025 } },
    { name: 'turnover: declared beats app_computed', op: 'resolvedTurnover', input: { entity: 'precedence', fyStartYear: 2025 } },
    { name: 'turnover: none recorded', op: 'resolvedTurnover', input: { entity: 'small', fyStartYear: 2023 } },
    e('B2B invoice above ₹10 cr: mandatory with the 30-day window'),
    e('crossed ₹5 cr in an earlier year: still mandatory, no 30-day window', { entity: 'crossed-once-long-ago' }),
    e('exactly ₹5 cr does not exceed the threshold', { entity: 'exactly-five-crore' }),
    e('below threshold', { entity: 'small' }),
    e('no turnover recorded', { entity: 'unknown' }),
    e('the current FY does not count', { entity: 'big-and-growing', documentDate: '2023-03-31' }),
    e('casual registration is evaluated like a normal one', { registrationId: 'reg-casual' }),
    e('SEZ unit is excluded', { registrationId: 'reg-sez-unit' }),
    e('SEZ developer is not excluded', { registrationId: 'reg-sez-developer' }),
    e('ISD registration issues no supply documents', { registrationId: 'reg-isd' }),
    e('composition scheme', { registrationId: 'reg-switches', documentDate: '2026-11-05' }),
    e('GTA entity is excluded', { entity: 'gta' }),
    e('an exemption category the rule set does not list excludes nothing', { entity: 'govt-not-in-rule-set' }),
    e('B2C buyer', { buyerTreatment: 'consumer' }),
    e('unregistered buyer', { buyerTreatment: 'unregistered' }),
    e('UIN holder buyer', { buyerTreatment: 'uin_holder' }),
    e('SEZ buyer', { buyerTreatment: 'sez_unit', supplyType: 'sez_without_tax' }),
    e('composition buyer is B2B', { buyerTreatment: 'registered_composition' }),
    e('export to an overseas buyer', { buyerTreatment: 'overseas', supplyType: 'export_without_tax' }),
    e('overseas buyer without an export supply', { buyerTreatment: 'overseas', supplyType: 'intra_state' }),
    e('credit note', { documentKind: 'credit_note' }),
    e('sales debit note', { documentKind: 'sales_debit_note' }),
    e('bill of supply', { documentKind: 'bill_of_supply' }),
    e('invoice-cum-bill of supply is never e-invoiced', { documentKind: 'invoice_cum_bill_of_supply', buyerTreatment: 'unregistered' }),
    e('RCM self-invoice stays optional', { documentKind: 'rcm_self_invoice' }),
    e('profile gap is an error', { registrationId: 'reg-gap', documentDate: '2020-05-15', entity: 'big-and-growing' }),
    h('HSN: above ₹5 cr, B2B needs 6 digits', 'big-and-growing', 'b2b'),
    h('HSN: above ₹5 cr, B2C needs 6 digits too', 'big-and-growing', 'b2c'),
    h('HSN: at or below ₹5 cr, B2B needs 4', 'exactly-five-crore', 'b2b'),
    h('HSN: at or below ₹5 cr, B2C optional', 'small', 'b2c'),
    h('HSN: unknown turnover treated as small', 'unknown', 'b2b'),
    h('HSN: only the preceding FY counts', 'crossed-once-long-ago', 'b2b'),
  ];
}

// --- Time of supply ----------------------------------------------------------------

export type TosCase =
  | {
      readonly name: string;
      readonly op: 'resolveTaxPoint';
      readonly input: { readonly facts: TaxPointFacts; readonly kind: TaxPointKind; readonly ruleSetVersion: string };
    }
  | { readonly name: string; readonly op: 'supplierReportedTaxPoint'; readonly input: { readonly date: string } }
  | { readonly name: string; readonly op: 'rateChangeDates'; readonly input: { readonly ruleSetVersion: string } }
  | { readonly name: string; readonly op: 'addDays'; readonly input: { readonly date: string; readonly days: number } };

export function tosCases(): TosCase[] {
  const V = '2026-11-01.2';
  const t = (name: string, kind: TaxPointKind, facts: TaxPointFacts): TosCase => ({
    name,
    op: 'resolveTaxPoint',
    input: { facts, kind, ruleSetVersion: V },
  });
  return [
    { name: 'rate changes come from the rule set, without its first date', op: 'rateChangeDates', input: { ruleSetVersion: V } },
    { name: 'days across a month end', op: 'addDays', input: { date: '2026-01-31', days: 30 } },
    { name: 'days across a leap day', op: 'addDays', input: { date: '2028-02-28', days: 1 } },
    { name: 'days across a year end', op: 'addDays', input: { date: '2026-12-15', days: 60 } },
    { name: 'an ordinary purchase keeps the supplier date', op: 'supplierReportedTaxPoint', input: { date: '2026-10-30' } },

    t('counter sale: invoice at the till', 'outward_goods', { invoiceDate: '2026-06-10' }),
    t('goods removed before the invoice: removal', 'outward_goods', { invoiceDate: '2026-06-12', removalDate: '2026-06-10' }),
    t('invoice before removal: invoice', 'outward_goods', { invoiceDate: '2026-06-10', removalDate: '2026-06-12' }),
    t('no movement: delivery decides the due date', 'outward_goods', { invoiceDate: '2026-06-12', deliveryDate: '2026-06-11' }),
    t('an explicit due date wins over removal', 'outward_goods', { invoiceDate: '2026-06-12', removalDate: '2026-06-11', invoiceDueDate: '2026-06-09' }),
    t('an advance on goods does not move the date', 'outward_goods', { invoiceDate: '2026-06-12', paymentDate: '2026-06-01' }),

    t('service invoiced in time: invoice', 'outward_services', { invoiceDate: '2026-06-20', serviceCompletionDate: '2026-06-01' }),
    t('service invoiced in time, paid earlier: payment', 'outward_services', { invoiceDate: '2026-06-20', serviceCompletionDate: '2026-06-01', paymentDate: '2026-05-25' }),
    t('service invoiced on the last day is still in time', 'outward_services', { invoiceDate: '2026-07-01', serviceCompletionDate: '2026-06-01' }),
    t('service invoiced late: completion', 'outward_services', { invoiceDate: '2026-07-02', serviceCompletionDate: '2026-06-01' }),
    t('service invoiced late, paid before completion: payment', 'outward_services', { invoiceDate: '2026-07-20', serviceCompletionDate: '2026-06-01', paymentDate: '2026-05-20' }),

    t('RCM goods: receipt first', 'inward_rcm_goods', { invoiceDate: '2026-06-20', supplierInvoiceDate: '2026-06-01', receiptDate: '2026-06-05', paymentDate: '2026-06-10' }),
    t('RCM goods: payment first', 'inward_rcm_goods', { invoiceDate: '2026-06-20', supplierInvoiceDate: '2026-06-01', receiptDate: '2026-06-10', paymentDate: '2026-06-05' }),
    t('RCM goods: 30 days after the supplier invoice', 'inward_rcm_goods', { invoiceDate: '2026-08-20', supplierInvoiceDate: '2026-06-01', receiptDate: '2026-08-10' }),
    t('RCM goods: nothing known, entry in the books', 'inward_rcm_goods', { invoiceDate: '2026-06-20' }),
    t('RCM services: payment first', 'inward_rcm_services', { invoiceDate: '2026-06-20', supplierInvoiceDate: '2026-06-01', paymentDate: '2026-06-10' }),
    t('RCM services: 60 days after the supplier invoice', 'inward_rcm_services', { invoiceDate: '2026-09-01', supplierInvoiceDate: '2026-06-01' }),

    t('s.14(a)(i): supplied before, invoice and payment after: earlier of the two', 'outward_goods', { invoiceDate: '2026-11-03', removalDate: '2026-10-30', paymentDate: '2026-11-05' }),
    t('s.14(a)(i): unpaid counts as after', 'outward_goods', { invoiceDate: '2026-11-03', removalDate: '2026-10-30' }),
    t('s.14(a)(ii): supplied and invoiced before, paid after: invoice', 'outward_goods', { invoiceDate: '2026-10-28', removalDate: '2026-10-30', paymentDate: '2026-11-05' }),
    t('s.14(a)(iii): supplied and paid before, invoiced after: payment', 'outward_goods', { invoiceDate: '2026-11-03', removalDate: '2026-10-30', paymentDate: '2026-10-29' }),
    t('s.14(b)(i): supplied after, invoiced before, paid after: payment', 'outward_goods', { invoiceDate: '2026-10-28', removalDate: '2026-11-03', paymentDate: '2026-11-05' }),
    t('s.14(b)(i): unpaid: the supply date stands in', 'outward_goods', { invoiceDate: '2026-10-28', removalDate: '2026-11-03' }),
    t('s.14(b)(ii): supplied after, invoiced and paid before: earlier of the two', 'outward_goods', { invoiceDate: '2026-10-28', removalDate: '2026-11-03', paymentDate: '2026-10-25' }),
    t('s.14(b)(iii): supplied and invoiced after, paid before: invoice', 'outward_goods', { invoiceDate: '2026-11-04', removalDate: '2026-11-03', paymentDate: '2026-10-25' }),
    t('a change on the event day counts as after it', 'outward_goods', { invoiceDate: '2026-11-01', removalDate: '2026-10-31' }),
    t('all events after the last change: no s.14', 'outward_goods', { invoiceDate: '2026-11-04', removalDate: '2026-11-03', paymentDate: '2026-11-05' }),
    t('s.14 for reverse charge uses receipt and the supplier invoice', 'inward_rcm_goods', { invoiceDate: '2026-11-20', supplierInvoiceDate: '2026-10-28', receiptDate: '2026-11-03' }),
    t('a bad document date is refused', 'outward_goods', { invoiceDate: 'soon' }),
  ];
}
