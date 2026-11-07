/**
 * What a tax invoice must say (CGST Rule 46, text in docs/gst/rule_46.txt) and the frozen party
 * snapshot it says it from (freeze §4.3). Shared with the Flutter app
 * (`packages/khata_domain/lib/src/gst/invoice_rules.dart`), so a bill refused on the server is
 * already refused at the till.
 */
import type { SupplyType } from '../tax/types.js';
import type { GstDocumentType, GstTreatment, Taxability } from './enums.js';
import { INDIA } from './place-of-supply.js';

/**
 * Rule 46(e): ₹50,000, in paise. The rule file `2017-07-01-cgst-rule-46.json` records the same
 * value for the rule set. Callers pass the value in, so reading it from a published rule set later
 * changes one line.
 */
export const RULE_46_UNREGISTERED_TAXABLE_PAISE = 5_000_000;

export interface SnapshotAddress {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly stateCode: string | null;
  readonly countryCode: string;
}

export interface PartySnapshot {
  readonly name: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly uin: string | null;
  readonly gstTreatment: GstTreatment | null;
  readonly address: SnapshotAddress;
  readonly phone: string | null;
  readonly email: string | null;
}

export type Rule46Field =
  | 'recipient_name'
  | 'recipient_address'
  | 'recipient_identity'
  | 'recipient_state'
  | 'delivery_address'
  | 'delivery_state'
  | 'destination_country';

export interface Rule46Input {
  readonly documentType: GstDocumentType | null;
  readonly supplyType: SupplyType;
  /** Null for a walk-in with no customer. */
  readonly buyer: PartySnapshot | null;
  /** Null when the goods go to the bill-to address or are handed over at the counter. */
  readonly shipTo: PartySnapshot | null;
  /** Paise. */
  readonly taxableValue: number;
  /** Paise. */
  readonly unregisteredThreshold: number;
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

const REGISTERED: readonly GstTreatment[] = ['registered_regular', 'registered_composition', 'sez_unit', 'sez_developer'];

/**
 * The particulars Rule 46 requires and the document lacks, in a fixed order; empty when complete.
 * Only a tax invoice is tested: a bill of supply falls under Rule 49. Below the threshold an
 * unregistered recipient's details are optional, clause (f).
 */
export function rule46MissingFields(input: Rule46Input): readonly Rule46Field[] {
  if (input.documentType !== 'tax_invoice' && input.documentType !== 'invoice_cum_bill_of_supply') return [];
  const { buyer, shipTo } = input;
  const delivery = shipTo?.address ?? buyer?.address ?? null;
  const missing: Rule46Field[] = [];

  // Second proviso: an export names the recipient, the delivery address and the destination
  // country in place of clause (e), at any value.
  if (input.supplyType === 'export_with_tax' || input.supplyType === 'export_without_tax') {
    if (buyer === null || blank(buyer.name)) missing.push('recipient_name');
    if (buyer === null || blank(buyer.address.line1)) missing.push('recipient_address');
    if (delivery === null || blank(delivery.line1)) missing.push('delivery_address');
    if (delivery === null || delivery.countryCode === INDIA) missing.push('destination_country');
    return missing;
  }

  const registered =
    buyer !== null &&
    (buyer.gstTreatment === 'uin_holder' || (buyer.gstTreatment !== null && REGISTERED.includes(buyer.gstTreatment)));
  if (registered) {
    // Clause (d): name, address and GSTIN or UIN.
    if (blank(buyer.name)) missing.push('recipient_name');
    if (blank(buyer.address.line1)) missing.push('recipient_address');
    if (blank(buyer.gstin) && blank(buyer.uin)) missing.push('recipient_identity');
    return missing;
  }

  // Clause (e): an unregistered recipient, at or above the threshold.
  if (input.taxableValue < input.unregisteredThreshold) return [];
  if (buyer === null || blank(buyer.name)) missing.push('recipient_name');
  if (buyer === null || blank(buyer.address.line1)) missing.push('recipient_address');
  if (buyer === null || blank(buyer.address.stateCode)) missing.push('recipient_state');
  if (delivery === null || blank(delivery.line1)) missing.push('delivery_address');
  if (delivery === null || blank(delivery.stateCode)) missing.push('delivery_state');
  return missing;
}

/**
 * The endorsement Rule 46 requires on an export or an SEZ supply for authorised operations, in the
 * rule's own words. A supply to an SEZ outside authorised operations is not zero-rated and has none.
 */
export function zeroRatedEndorsement(supplyType: SupplyType, sezAuthorisedOperations: boolean | null): string | null {
  const isSez = supplyType === 'sez_with_tax' || supplyType === 'sez_without_tax';
  if (isSez && sezAuthorisedOperations !== true) return null;
  if (supplyType === 'export_with_tax' || supplyType === 'sez_with_tax') {
    return 'SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX';
  }
  if (supplyType === 'export_without_tax' || supplyType === 'sez_without_tax') {
    return 'SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX';
  }
  return null;
}

const UNREGISTERED_BUYERS: readonly (GstTreatment | null)[] = [null, 'consumer', 'unregistered'];

/**
 * The document this sale is (D9). Rule 46A: one document for taxable and exempt goods sold to an
 * unregistered person. A registered buyer gets a tax invoice whatever the lines are.
 */
export function documentTypeFor(
  mode: 'gst' | 'composition' | 'non_gst',
  buyerTreatment: GstTreatment | null,
  supplyCategories: readonly Taxability[],
): GstDocumentType | null {
  if (mode === 'non_gst') return null;
  if (mode === 'composition') return 'bill_of_supply';
  const mixed = supplyCategories.includes('taxable') && supplyCategories.some((c) => c !== 'taxable');
  return mixed && UNREGISTERED_BUYERS.includes(buyerTreatment) ? 'invoice_cum_bill_of_supply' : 'tax_invoice';
}

/** Union territories without a legislature charge UTGST where a state charges SGST (D6). */
const UTGST_STATE_CODES: readonly string[] = ['04', '26', '31', '35', '38'];

export function stateTaxLabel(placeOfSupply: string | null): 'SGST' | 'UTGST' {
  return placeOfSupply !== null && UTGST_STATE_CODES.includes(placeOfSupply) ? 'UTGST' : 'SGST';
}

/** Whether a document's tax falls under IGST: anything but a supply within one state. */
export function usesIgst(supplyType: SupplyType): boolean {
  return supplyType !== 'intra_state';
}
