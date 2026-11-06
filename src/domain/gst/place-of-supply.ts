/**
 * Place of supply from the supply scenario (D24), shared with the Flutter app
 * (`packages/khata_domain/lib/src/gst/place_of_supply.dart`). A scenario names what physically
 * happened, so each one maps to one statutory provision. Anything outside the supported list is
 * refused with a typed error: there is no generic fallback, because a wrong place of supply puts
 * the tax under the wrong head.
 *
 * Statute: IGST Act s.7(5)(b), s.10(1)(a)-(d), s.11, s.12(2).
 */
import { ErrorCode, UnprocessableError, ValidationError } from '../../lib/errors.js';
import type { SupplyType } from '../tax/types.js';
import type { GstTreatment, PosProvision, SupplyScenario } from './enums.js';

/** The GST state code for a place outside India. */
export const FOREIGN_POS_CODE = '96';
export const INDIA = 'IN';

export interface PosAddress {
  /** GST state code; null abroad. */
  readonly stateCode: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly countryCode: string;
}

export interface PosInput {
  readonly scenario: SupplyScenario;
  /** Where the goods are dispatched from: the outlet's state. */
  readonly supplierStateCode: string;
  /** Null for a walk-in with no customer. */
  readonly buyerTreatment: GstTreatment | null;
  readonly billTo: PosAddress | null;
  readonly shipTo: PosAddress | null;
  /** Only for `goods_without_movement`: where the goods are when delivered. */
  readonly goodsLocationStateCode?: string | null;
  /** Only for `supply_to_sez`. */
  readonly sezAuthorisedOperations?: boolean | null;
  /** Only for `supply_to_sez`: supplied under bond or LUT, without tax. */
  readonly sezUnderLut?: boolean | null;
}

export interface PosResult {
  readonly placeOfSupply: string;
  readonly supplyType: SupplyType;
  readonly provision: PosProvision;
  /** A stable reason code, for display and the audit trail. */
  readonly reason: string;
}

const SEZ_TREATMENTS: readonly GstTreatment[] = ['sez_unit', 'sez_developer'];

function unsupported(message: string, input: PosInput, reason: string): UnprocessableError {
  return new UnprocessableError(message, ErrorCode.UNSUPPORTED_SCENARIO, {
    details: { scenario: input.scenario, reason },
  });
}

function missing(message: string, input: PosInput, reason: string): ValidationError {
  return new ValidationError(message, { details: { scenario: input.scenario, reason } });
}

function domestic(input: PosInput, address: PosAddress | null, what: string): string {
  if (address !== null && address.countryCode !== INDIA) {
    throw unsupported(`${what} is outside India: use an export scenario.`, input, 'address_abroad');
  }
  if (address === null || address.stateCode === null) {
    throw missing(`${what} needs a state.`, input, 'state_required');
  }
  return address.stateCode;
}

function domesticResult(input: PosInput, placeOfSupply: string, provision: PosProvision, reason: string): PosResult {
  return {
    placeOfSupply,
    supplyType: placeOfSupply === input.supplierStateCode ? 'intra_state' : 'inter_state',
    provision,
    reason,
  };
}

function exportResult(input: PosInput, supplyType: SupplyType, reason: string): PosResult {
  const destination = input.shipTo ?? input.billTo;
  if (destination === null || destination.countryCode === INDIA) {
    throw missing('An export needs a destination outside India.', input, 'destination_country_required');
  }
  return { placeOfSupply: FOREIGN_POS_CODE, supplyType, provision: 'igst_11', reason };
}

function sezResult(input: PosInput): PosResult {
  if (input.buyerTreatment === null || !SEZ_TREATMENTS.includes(input.buyerTreatment)) {
    throw unsupported('A supply to an SEZ needs an SEZ unit or developer as the buyer.', input, 'buyer_not_sez');
  }
  if (input.sezAuthorisedOperations === null || input.sezAuthorisedOperations === undefined) {
    throw missing('Say whether this supply to the SEZ is for authorised operations.', input, 'authorised_operations_required');
  }
  if (!input.sezAuthorisedOperations && input.sezUnderLut === true) {
    throw missing('Only a supply for authorised operations can go under LUT.', input, 'lut_needs_authorised_operations');
  }
  // Inter-state wherever the SEZ is, including the supplier's own state. A supply outside
  // authorised operations is taxed and not zero-rated: `sez_with_tax` charges IGST, and the
  // stored authorised-operations flag keeps it apart from zero-rated supplies in returns.
  return {
    placeOfSupply: domestic(input, input.shipTo ?? input.billTo, 'The SEZ address'),
    supplyType: input.sezUnderLut === true ? 'sez_without_tax' : 'sez_with_tax',
    provision: 'igst_7_5_b',
    reason: input.sezAuthorisedOperations ? 'sez_authorised' : 'sez_not_authorised_taxed',
  };
}

function servicesResult(input: PosInput): PosResult {
  const { billTo, buyerTreatment } = input;
  if (buyerTreatment === 'overseas' || (billTo !== null && billTo.countryCode !== INDIA)) {
    throw unsupported('Services to a recipient abroad are not supported yet.', input, 'cross_border_service');
  }
  const registered =
    buyerTreatment === 'registered_regular' || buyerTreatment === 'registered_composition' || buyerTreatment === 'uin_holder';
  if (registered) {
    return domesticResult(input, domestic(input, billTo, 'The registered recipient'), 'igst_12_2', 'recipient_location');
  }
  if (billTo !== null && billTo.stateCode !== null) {
    return domesticResult(input, billTo.stateCode, 'igst_12_2', 'address_on_record');
  }
  return domesticResult(input, input.supplierStateCode, 'igst_12_2', 'supplier_location');
}

/**
 * The place of supply and supply type for a scenario, or a typed refusal: UNSUPPORTED_SCENARIO
 * for something the app does not handle, VALIDATION_FAILED for missing facts the seller can add.
 */
export function resolvePlaceOfSupply(input: PosInput): PosResult {
  const { scenario, buyerTreatment } = input;

  if (buyerTreatment !== null && SEZ_TREATMENTS.includes(buyerTreatment) && scenario !== 'supply_to_sez') {
    throw unsupported('A sale to an SEZ buyer must use the supply-to-SEZ scenario.', input, 'sez_buyer_needs_sez_scenario');
  }
  // A visitor from abroad buying at the counter is an ordinary supply in India: s.10(1)(c).
  const allowedForOverseas =
    scenario === 'counter_sale' || scenario === 'export_goods_with_payment' || scenario === 'export_goods_under_lut';
  if (buyerTreatment === 'overseas' && !allowedForOverseas && scenario !== 'services_general') {
    throw unsupported('A sale to an overseas buyer is a counter sale or an export.', input, 'overseas_buyer_scenario');
  }

  switch (scenario) {
    case 'counter_sale':
      return domesticResult(input, input.supplierStateCode, 'igst_10_1_c', 'handed_over_at_seller');
    case 'delivered':
      return domesticResult(input, domestic(input, input.shipTo ?? input.billTo, 'The delivery address'), 'igst_10_1_a', 'movement_ends_at_delivery');
    case 'bill_to_ship_to':
      if (input.shipTo === null) throw missing('Bill-to-ship-to needs a ship-to address.', input, 'ship_to_required');
      return domesticResult(input, domestic(input, input.billTo, 'The bill-to party'), 'igst_10_1_b', 'buyer_directing_delivery');
    case 'goods_without_movement': {
      const location = input.goodsLocationStateCode;
      if (location === null || location === undefined) {
        throw missing('Say which state the goods are in.', input, 'goods_location_required');
      }
      return domesticResult(input, location, 'igst_10_1_c', 'location_of_goods');
    }
    case 'installation_at_site':
      return domesticResult(input, domestic(input, input.shipTo ?? input.billTo, 'The installation site'), 'igst_10_1_d', 'place_of_installation');
    case 'export_goods_with_payment':
      return exportResult(input, 'export_with_tax', 'export_with_payment');
    case 'export_goods_under_lut':
      return exportResult(input, 'export_without_tax', 'export_under_lut');
    case 'supply_to_sez':
      return sezResult(input);
    case 'services_general':
      return servicesResult(input);
    default:
      throw unsupported(`The ${scenario} scenario is not supported.`, input, 'scenario_not_supported');
  }
}
