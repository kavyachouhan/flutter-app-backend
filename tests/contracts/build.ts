/**
 * Turns contract case inputs into the vector files under contracts/, and is
 * also what the contract test runs to prove the committed files still match
 * the engine. Both the generator and the test go through here so they can
 * never disagree about what a vector means.
 */
import { isAppError } from '../../src/lib/errors.js';
import { PERMISSIONS, ROLES, permissionsFor, type Role } from '../../src/modules/auth/permissions.js';
import { FEATURES } from '../../src/modules/entitlements/entitlements.js';
import { PLANS, PLAN_CODES } from '../../src/modules/entitlements/plans.js';
import { DOCUMENT_TYPES } from '../../src/modules/numbering/numbering.schemas.js';
import {
  financialYearOf,
  formatDocumentNumber,
  isBlockExhausted,
  maxSequenceFor,
  mergeRanges,
  nextInBlock,
  remainingInBlock,
  unusedTails,
  validateSeriesFormat,
  type NumberBlock,
} from '../../src/domain/numbering/series.js';
import {
  apportionLandedCost,
} from '../../src/domain/costing/landed-cost.js';
import {
  applyReceipt,
  costOfGoodsSold,
  reverseReceipt,
} from '../../src/domain/costing/moving-average.js';
import { dueDateFor } from '../../src/domain/purchases/due-date.js';
import { computeInvoice } from '../../src/domain/tax/engine.js';
import { deriveReturnLine } from '../../src/domain/tax/returns.js';
import type { TaxInvoiceInput } from '../../src/domain/tax/types.js';
import { costingCases, type CostingContractCase } from './costing-cases.js';
import { numberingCases, type BlockInput, type NumberingContractCase } from './numbering-cases.js';
import { returnsCases, type ReturnsContractCase } from './returns-cases.js';
import { allTaxCases, CONTRACT_GST_RATES } from './tax-cases.js';
import {
  einvoiceApplicability,
  hsnRequirement,
  resolvedTurnover,
  statutoryFyStartYear,
  type EntityFacts,
} from '../../src/domain/gst/entity.js';
import type { ThresholdKey } from '../../src/domain/gst/enums.js';
import {
  gstinMatchesState,
  gstinProblem,
  isUinFormatValid,
  normaliseGstin,
} from '../../src/domain/gst/gstin.js';
import {
  isRegistrationInForce,
  profileInForce,
  taxModeFor,
  type RegistrationFacts,
} from '../../src/domain/gst/registration.js';
import {
  checkLineRate,
  isCessAllowed,
  isRateAllowed,
  ratesFor,
  selectRuleSet,
  thresholdValue,
  validationEnforcement,
  type GstRuleSet,
} from '../../src/domain/gst/rule-set.js';
import {
  addDays,
  rateChangeDates,
  resolveTaxPoint,
  supplierReportedTaxPoint,
} from '../../src/domain/gst/time-of-supply.js';
import { resolvePlaceOfSupply } from '../../src/domain/gst/place-of-supply.js';
import {
  adjustmentLine,
  correctionRoute,
  creditNoteLastDate,
  voidRefusal,
} from '../../src/domain/gst/corrections.js';
import {
  documentTypeFor,
  rule46MissingFields,
  stateTaxLabel,
  usesIgst,
  zeroRatedEndorsement,
} from '../../src/domain/gst/invoice-rules.js';
import {
  ENTITIES,
  REGISTRATIONS,
  RULE_SETS,
  entityCases,
  gstinCases,
  registrationCases,
  ruleSetCases,
  tosCases,
  posCases,
  invoiceRulesCases,
  correctionsCases,
  type CorrectionsCase,
  type InvoiceRulesCase,
  type PosCase,
  type TosCase,
  type EntityCase,
  type GstinCase,
  type RegistrationCase,
  type RuleSetCase,
} from './gst-cases.js';

/** What the reference implementation produced for a case. */
export type ContractOutcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: string; readonly message: string } };

export interface TaxVectorsFile {
  readonly contract: 'tax-engine';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly rules: { readonly allowedGstRates: readonly number[] };
  readonly cases: readonly {
    readonly name: string;
    readonly input: TaxInvoiceInput;
    readonly expected: ContractOutcome;
  }[];
}

export interface NumberingVectorsFile {
  readonly contract: 'numbering';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly cases: readonly (NumberingContractCase & { readonly expected: ContractOutcome })[];
}

export interface CostingVectorsFile {
  readonly contract: 'costing';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly cases: readonly (CostingContractCase & { readonly expected: ContractOutcome })[];
}

export interface ReturnsVectorsFile {
  readonly contract: 'returns';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly cases: readonly (ReturnsContractCase & { readonly expected: ContractOutcome })[];
}

function outcome(run: () => unknown): ContractOutcome {
  try {
    return { result: run() ?? null };
  } catch (error) {
    if (isAppError(error)) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

/** Strips `undefined` members the way JSON.stringify does, so in-memory and on-disk shapes match. */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function evaluateTaxCase(input: TaxInvoiceInput): ContractOutcome {
  return outcome(() => computeInvoice(input, { allowedGstRates: new Set(CONTRACT_GST_RATES) }));
}

const toBlock = (b: BlockInput): NumberBlock => ({ ...b, expiresAt: new Date(b.expiresAt) });

export function evaluateNumberingCase(c: NumberingContractCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'financialYearOf':
        return financialYearOf(c.input.date, c.input.fyStartMonth);
      case 'formatDocumentNumber':
        return formatDocumentNumber(
          c.input.format,
          financialYearOf(c.input.fy.date, c.input.fy.fyStartMonth),
          c.input.sequenceNo,
          c.input.maxLength,
        );
      case 'maxSequenceFor':
        return maxSequenceFor(
          c.input.format,
          financialYearOf(c.input.fy.date, c.input.fy.fyStartMonth),
          c.input.maxLength,
        );
      case 'validateSeriesFormat':
        validateSeriesFormat(
          c.input.format,
          financialYearOf(c.input.fy.date, c.input.fy.fyStartMonth),
          c.input.rules,
        );
        return null;
      case 'remainingInBlock':
        return remainingInBlock(toBlock(c.input.block));
      case 'isBlockExhausted':
        return isBlockExhausted(toBlock(c.input.block), new Date(c.input.now));
      case 'nextInBlock':
        return nextInBlock(toBlock(c.input.block), new Date(c.input.now));
      case 'unusedTails':
        return unusedTails(c.input.blocks.map(toBlock), new Date(c.input.now));
      case 'mergeRanges':
        return mergeRanges(c.input.ranges);
    }
  });
}

export function evaluateCostingCase(c: CostingContractCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'apportionLandedCost':
        return apportionLandedCost(c.input);
      case 'applyReceipt':
        return applyReceipt(c.input.state, c.input.receipt);
      case 'reverseReceipt':
        return reverseReceipt(c.input.state, c.input.receipt);
      case 'costOfGoodsSold':
        return costOfGoodsSold(c.input.avgCost, c.input.quantity);
      case 'dueDateFor':
        return dueDateFor(c.input.documentDate, c.input.termsDays);
    }
  });
}

export function evaluateReturnsCase(c: ReturnsContractCase): ContractOutcome {
  return outcome(() => deriveReturnLine(c.input.sold, c.input.request));
}

export function buildTaxVectors(): TaxVectorsFile {
  return jsonClone({
    contract: 'tax-engine',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/tax/engine.ts; do not edit by hand.',
      'Amounts are integer paise; quantities are integer thousandths of a unit.',
      'A key absent from an object means undefined (e.g. no hsnCode, no discount); a port must treat absent and null alike.',
      'expected.result is the exact TaxInvoiceResult; a port must match every field, including lines[], taxSummary[] and hsnSummary[] order.',
      'expected.error means the engine rejected the input with that error code; a port must reject too, and may word the message differently.',
      'Arithmetic is IEEE-754 double then rounded half away from zero; largest-remainder apportionment breaks ties by line order (stable sort).',
    ],
    rules: { allowedGstRates: CONTRACT_GST_RATES },
    cases: allTaxCases().map((c) => ({ ...c, expected: evaluateTaxCase(c.input) })),
  });
}

export function buildNumberingVectors(): NumberingVectorsFile {
  return jsonClone({
    contract: 'numbering',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/numbering/series.ts; do not edit by hand.',
      'Dates are calendar strings (YYYY-MM-DD); instants are ISO-8601 UTC strings.',
      'A financial year in an input is given as {date, fyStartMonth} and must be resolved with financialYearOf first.',
      'validateSeriesFormat returns null on success; nextInBlock returns null when the block is spent or expired.',
      'expected.error means the reference rejected the input with that error code; a port must reject too.',
    ],
    cases: numberingCases().map((c) => ({ ...c, expected: evaluateNumberingCase(c) })),
  });
}

export function buildCostingVectors(): CostingVectorsFile {
  return jsonClone({
    contract: 'costing',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/costing/*.ts and src/domain/purchases/due-date.ts; do not edit by hand.',
      'Amounts are integer paise; quantities are integer thousandths of a unit; avgCost and unitCost are paise per whole unit.',
      'expected.result is the exact return value: an array of {landedCostShare, effectiveUnitCost, lineCost} for apportionLandedCost, a {avgCost, quantityOnHand} state for applyReceipt and reverseReceipt, an integer for costOfGoodsSold, and a YYYY-MM-DD string or null for dueDateFor.',
      'Every product and quotient is computed in IEEE-754 double and rounded once, half away from zero. Products above 2^53 lose precision on the server, so a port must use doubles there too, not 64-bit integers.',
      'Largest-remainder apportionment breaks ties by line order.',
    ],
    cases: costingCases().map((c) => ({ ...c, expected: evaluateCostingCase(c) })),
  });
}

export function buildReturnsVectors(): ReturnsVectorsFile {
  return jsonClone({
    contract: 'returns',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/tax/returns.ts; do not edit by hand.',
      'input is {sold, request}: the invoice line as sold and the quantity being returned (integer thousandths).',
      'expected.result is the tax-engine line input the return becomes. A key absent from it means undefined (no discount, no hsnCode); a port must treat absent and null alike.',
      'supplyCategory is copied from the sold line and must survive: a credit note reverses the supply it was issued against.',
      'expected.error means the reference rejected the request with that error code; a port must reject too.',
    ],
    cases: returnsCases().map((c) => ({ ...c, expected: evaluateReturnsCase(c) })),
  });
}


/**
 * Who may do what, which plan grants which feature, and which document types a series
 * can be for. The app keeps its own copies of these lists (it has to hide a button
 * before the server would refuse it), so they are published here and the app's test
 * compares: a permission added on one side and not the other fails a build instead of
 * silently never showing, or never being refused.
 */
export interface AccessVectorsFile {
  readonly contract: 'access';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly permissions: readonly string[];
  readonly roles: Readonly<Record<Role, readonly string[]>>;
  readonly features: readonly string[];
  readonly plans: Readonly<Record<string, readonly string[]>>;
  readonly documentTypes: readonly string[];
}

export function buildAccessVectors(): AccessVectorsFile {
  return {
    contract: 'access',
    version: 1,
    notes: [
      'permissions is the full list, in the server order; roles maps each role to what it holds.',
      "plans lists the feature keys each plan is seeded with; '*' grants every feature.",
      'documentTypes are the values a numbering series can have.',
    ],
    permissions: [...PERMISSIONS],
    roles: Object.fromEntries(ROLES.map((role) => [role, permissionsFor(role)])) as unknown as Record<
      Role,
      readonly string[]
    >,
    features: [...FEATURES],
    plans: Object.fromEntries(PLAN_CODES.map((code) => [code, [...PLANS[code].features]])),
    documentTypes: [...DOCUMENT_TYPES],
  };
}

// --- GST (A0b): GSTIN, rule set, registration, entity -------------------------

export interface GstinVectorsFile {
  readonly contract: 'gstin';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly cases: readonly (GstinCase & { readonly expected: ContractOutcome })[];
}

export interface RuleSetVectorsFile {
  readonly contract: 'gst-rule-set';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly ruleSets: readonly GstRuleSet[];
  readonly cases: readonly (RuleSetCase & { readonly expected: ContractOutcome })[];
}

export interface RegistrationVectorsFile {
  readonly contract: 'gst-registration';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly registrations: readonly RegistrationFacts[];
  readonly cases: readonly (RegistrationCase & { readonly expected: ContractOutcome })[];
}

export interface EntityVectorsFile {
  readonly contract: 'gst-entity';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly ruleSets: readonly GstRuleSet[];
  readonly registrations: readonly RegistrationFacts[];
  readonly entities: Readonly<Record<string, EntityFacts>>;
  readonly cases: readonly (EntityCase & { readonly expected: ContractOutcome })[];
}

function ruleSetByVersion(version: string): GstRuleSet {
  const found = RULE_SETS.find((r) => r.version === version);
  if (!found) throw new Error(`Unknown fixture rule set ${version}`);
  return found;
}

function registrationById(id: string): RegistrationFacts {
  const found = REGISTRATIONS.find((r) => r.id === id);
  if (!found) throw new Error(`Unknown fixture registration ${id}`);
  return found;
}

function entityByName(name: string): EntityFacts {
  const found = ENTITIES[name];
  if (!found) throw new Error(`Unknown fixture entity ${name}`);
  return found;
}

export function evaluateGstinCase(c: GstinCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'gstinProblem':
        return gstinProblem(c.input.value);
      case 'isUinFormatValid':
        return isUinFormatValid(c.input.value);
      case 'normaliseGstin':
        return normaliseGstin(c.input.value);
      case 'gstinMatchesState':
        return gstinMatchesState(c.input.value, c.input.stateCode ?? '');
    }
  });
}

export function evaluateRuleSetCase(c: RuleSetCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'selectRuleSet':
        return selectRuleSet(c.input.date, RULE_SETS).version;
      case 'thresholdValue':
        return thresholdValue(ruleSetByVersion(c.input.version), c.input.key as ThresholdKey, c.input.date);
      case 'isRateAllowed':
        return isRateAllowed(ruleSetByVersion(c.input.version), c.input.ratePercent, c.input.date);
      case 'isCessAllowed':
        return isCessAllowed(ruleSetByVersion(c.input.version), c.input.date);
      case 'validationEnforcement':
        return validationEnforcement(ruleSetByVersion(c.input.version), c.input.id, c.input.date);
      case 'ratesFor':
        return ratesFor(ruleSetByVersion(c.input.version), c.input.kind, c.input.code, c.input.date).map((r) => r.id);
      case 'checkLineRate':
        return checkLineRate(ruleSetByVersion(c.input.version), c.input.line, c.input.date);
    }
  });
}

export function evaluateRegistrationCase(c: RegistrationCase): ContractOutcome {
  return outcome(() => {
    const registration = c.input.registrationId === null ? null : registrationById(c.input.registrationId);
    switch (c.op) {
      case 'profileInForce':
        return profileInForce(registration!, c.input.date);
      case 'taxModeFor':
        return taxModeFor(registration, c.input.date);
      case 'isRegistrationInForce':
        return isRegistrationInForce(registration!, c.input.date);
    }
  });
}

export function evaluateEntityCase(c: EntityCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'statutoryFyStartYear':
        return statutoryFyStartYear(c.input.date);
      case 'resolvedTurnover':
        return resolvedTurnover(entityByName(c.input.entity), c.input.fyStartYear);
      case 'einvoiceApplicability':
        return einvoiceApplicability({
          entity: entityByName(c.input.entity),
          registration: registrationById(c.input.registrationId),
          documentKind: c.input.documentKind,
          buyerTreatment: c.input.buyerTreatment,
          supplyType: c.input.supplyType,
          documentDate: c.input.documentDate,
          ruleSet: ruleSetByVersion(c.input.ruleSetVersion),
        });
      case 'hsnRequirement':
        return hsnRequirement(
          entityByName(c.input.entity),
          c.input.documentDate,
          c.input.buyerClass,
          ruleSetByVersion(c.input.ruleSetVersion),
        );
    }
  });
}

const GST_FIXTURE_NOTE =
  'Fixture rule sets use notificationRef "TEST": they exercise the evaluator, they are not the real notified rates.';

export function buildGstinVectors(): GstinVectorsFile {
  return jsonClone({
    contract: 'gstin',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/gstin.ts; do not edit by hand.',
      'gstinProblem returns null for a valid GSTIN, else "format" | "state_code" | "checksum" (checked in that order).',
      'The SQL function app.gstin_valid() must agree: valid exactly when gstinProblem is null.',
      'The validator does not normalise; normaliseGstin is a separate operation.',
    ],
    cases: gstinCases().map((c) => ({ ...c, expected: evaluateGstinCase(c) })),
  });
}

export function buildRuleSetVectors(): RuleSetVectorsFile {
  return jsonClone({
    contract: 'gst-rule-set',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/rule-set.ts; do not edit by hand.',
      GST_FIXTURE_NOTE,
      'Dates are ISO strings; effectiveTo is exclusive. selectRuleSet returns the chosen version string.',
      'ratesFor returns candidate ids sorted ascending. checkLineRate returns {outcome, ...} exactly as in the reference.',
      'expected.error.code RULE_SET_UNAVAILABLE / VALIDATION_FAILED must be raised by the port for the same inputs.',
    ],
    ruleSets: RULE_SETS,
    cases: ruleSetCases().map((c) => ({ ...c, expected: evaluateRuleSetCase(c) })),
  });
}

export function buildRegistrationVectors(): RegistrationVectorsFile {
  return jsonClone({
    contract: 'gst-registration',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/registration.ts; do not edit by hand.',
      'Registration and profile ranges are half-open [effectiveFrom, effectiveTo).',
      'registrationId null means the outlet has no GST registration.',
    ],
    registrations: REGISTRATIONS,
    cases: registrationCases().map((c) => ({ ...c, expected: evaluateRegistrationCase(c) })),
  });
}

export function buildEntityVectors(): EntityVectorsFile {
  return jsonClone({
    contract: 'gst-entity',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/entity.ts; do not edit by hand.',
      GST_FIXTURE_NOTE,
      'Turnover and thresholds are paise. Turnover years are statutory FYs (April-March).',
      'Inputs reference fixtures in this file by key: entities by name, registrations by id, rule sets by version.',
    ],
    ruleSets: RULE_SETS,
    registrations: REGISTRATIONS,
    entities: ENTITIES,
    cases: entityCases().map((c) => ({ ...c, expected: evaluateEntityCase(c) })),
  });
}

export interface TosVectorsFile {
  readonly contract: 'gst-time-of-supply';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly ruleSets: readonly GstRuleSet[];
  readonly cases: readonly (TosCase & { readonly expected: ContractOutcome })[];
}

export function evaluateTosCase(c: TosCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'resolveTaxPoint':
        return resolveTaxPoint(c.input.facts, c.input.kind, ruleSetByVersion(c.input.ruleSetVersion));
      case 'supplierReportedTaxPoint':
        return supplierReportedTaxPoint(c.input.date);
      case 'rateChangeDates':
        return rateChangeDates(ruleSetByVersion(c.input.ruleSetVersion));
      case 'addDays':
        return addDays(c.input.date, c.input.days);
    }
  });
}

export function buildTosVectors(): TosVectorsFile {
  return jsonClone({
    contract: 'gst-time-of-supply',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/time-of-supply.ts; do not edit by hand.',
      GST_FIXTURE_NOTE,
      'resolveTaxPoint returns {date, provision}. rateChangeDates are sorted ascending.',
    ],
    ruleSets: RULE_SETS,
    cases: tosCases().map((c) => ({ ...c, expected: evaluateTosCase(c) })),
  });
}

export interface PosVectorsFile {
  readonly contract: 'gst-place-of-supply';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly cases: readonly (PosCase & { readonly expected: ContractOutcome })[];
}

export function evaluatePosCase(c: PosCase): ContractOutcome {
  return outcome(() => resolvePlaceOfSupply(c.input));
}

export function buildPosVectors(): PosVectorsFile {
  return jsonClone({
    contract: 'gst-place-of-supply',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/place-of-supply.ts; do not edit by hand.',
      'resolvePlaceOfSupply returns {placeOfSupply, supplyType, provision, reason}.',
    ],
    cases: posCases().map((c) => ({ ...c, expected: evaluatePosCase(c) })),
  });
}

export interface InvoiceRulesVectorsFile {
  readonly contract: 'gst-invoice-rules';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly cases: readonly (InvoiceRulesCase & { readonly expected: ContractOutcome })[];
}

export function evaluateInvoiceRulesCase(c: InvoiceRulesCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'documentTypeFor':
        return documentTypeFor(c.input.mode, c.input.buyerTreatment, c.input.supplyCategories);
      case 'rule46MissingFields':
        return rule46MissingFields(c.input);
      case 'zeroRatedEndorsement':
        return zeroRatedEndorsement(c.input.supplyType, c.input.sezAuthorisedOperations);
      case 'stateTaxLabel':
        return stateTaxLabel(c.input.placeOfSupply);
      case 'usesIgst':
        return usesIgst(c.input.supplyType);
    }
  });
}

export function buildInvoiceRulesVectors(): InvoiceRulesVectorsFile {
  return jsonClone({
    contract: 'gst-invoice-rules',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/invoice-rules.ts; do not edit by hand.',
      'Rule 46 text: docs/gst/rule_46.txt. rule46MissingFields returns the missing particulars in a fixed order.',
    ],
    cases: invoiceRulesCases().map((c) => ({ ...c, expected: evaluateInvoiceRulesCase(c) })),
  });
}

export interface CorrectionsVectorsFile {
  readonly contract: 'gst-corrections';
  readonly version: 1;
  readonly notes: readonly string[];
  readonly cases: readonly (CorrectionsCase & { readonly expected: ContractOutcome })[];
}

export function evaluateCorrectionsCase(c: CorrectionsCase): ContractOutcome {
  return outcome(() => {
    switch (c.op) {
      case 'correctionRoute':
        return correctionRoute(c.input.situation, c.input.facts);
      case 'voidRefusal':
        return voidRefusal(c.input.facts);
      case 'creditNoteLastDate':
        return creditNoteLastDate(c.input.invoiceDate, c.input.annualReturnFiledOn);
      case 'adjustmentLine':
        return adjustmentLine(c.input.sold, c.input.request);
    }
  });
}

export function buildCorrectionsVectors(): CorrectionsVectorsFile {
  return jsonClone({
    contract: 'gst-corrections',
    version: 1,
    notes: [
      'Generated by `npm run contracts:generate` from src/domain/gst/corrections.ts; do not edit by hand.',
      'correctionRoute returns the mechanism for a situation (D27). adjustmentLine returns a tax line.',
    ],
    cases: correctionsCases().map((c) => ({ ...c, expected: evaluateCorrectionsCase(c) })),
  });
}
