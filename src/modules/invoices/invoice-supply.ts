/**
 * Decides an invoice's place of supply (D24) and freezes who it is between (D8). Everything the
 * printed document and the return later say about the parties comes from what is stored here, so
 * editing a customer never rewrites an issued bill.
 */
import { resolvePlaceOfSupply, type PosAddress, type PosResult } from '../../domain/gst/place-of-supply.js';
import {
  RULE_46_UNREGISTERED_TAXABLE_PAISE,
  rule46MissingFields,
  type PartySnapshot,
} from '../../domain/gst/invoice-rules.js';
import type { GstDocumentType, PosProvision, SupplyScenario } from '../../domain/gst/enums.js';
import type { SupplyType, TaxMode } from '../../domain/tax/types.js';
import type { Tx } from '../../db/tx.js';
import { requireAuthContext } from '../../lib/context.js';
import { ErrorCode, ForbiddenError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { hasPermission } from '../auth/permissions.js';
import { customersRepository, type CustomerRow } from '../customers/customers.repository.js';
import type { OutletRow } from '../outlets/outlets.repository.js';
import type { TenantRow } from '../tenants/tenants.repository.js';
import type { CreateInvoiceBody } from './invoices.schemas.js';

export function sellerSnapshot(tenant: TenantRow, outlet: OutletRow, mode: TaxMode): PartySnapshot {
  const gstin = outlet.gstin ?? tenant.gstin;
  return {
    name: tenant.name,
    legalName: tenant.legalName,
    gstin,
    uin: null,
    gstTreatment: mode === 'gst' ? 'registered_regular' : mode === 'composition' ? 'registered_composition' : 'unregistered',
    address: outletAddress(tenant, outlet),
    phone: outlet.phone ?? tenant.phone,
    email: tenant.email,
  };
}

function outletAddress(tenant: TenantRow, outlet: OutletRow): PartySnapshot['address'] {
  return {
    line1: outlet.addressLine1 ?? tenant.addressLine1,
    line2: outlet.addressLine2 ?? tenant.addressLine2,
    city: outlet.city ?? tenant.city,
    postalCode: outlet.pincode ?? tenant.pincode,
    stateCode: outlet.stateCode ?? tenant.stateCode,
    countryCode: 'IN',
  };
}

/** Where the goods leave from: the outlet, under the seller's own name. */
export function dispatchSnapshot(tenant: TenantRow, outlet: OutletRow): PartySnapshot {
  return {
    name: outlet.name,
    legalName: null,
    gstin: null,
    uin: null,
    gstTreatment: null,
    address: outletAddress(tenant, outlet),
    phone: outlet.phone ?? tenant.phone,
    email: null,
  };
}

export function customerSnapshot(customer: CustomerRow): PartySnapshot {
  return {
    name: customer.name,
    legalName: null,
    gstin: customer.gstin,
    uin: customer.uin,
    gstTreatment: customer.gstTreatment,
    address: {
      line1: customer.addressLine1,
      line2: customer.addressLine2,
      city: customer.city,
      postalCode: customer.pincode,
      stateCode: customer.stateCode,
      countryCode: customer.countryCode,
    },
    phone: customer.phone,
    email: customer.email,
  };
}

export interface InvoiceSupply {
  /** Null outside GST mode, where no tax head depends on it. */
  readonly scenario: SupplyScenario | null;
  readonly provision: PosProvision | null;
  readonly override: Record<string, unknown> | null;
  /** What the scenario gave, before any override; kept for the audit trail. */
  readonly resolvedPlaceOfSupply: string | undefined;
  readonly sezAuthorisedOperations: boolean | null;
  readonly placeOfSupply: string | undefined;
  readonly supplyType: SupplyType | undefined;
  readonly buyer: PartySnapshot | null;
  readonly shipTo: PartySnapshot | null;
}

function posAddress(party: PartySnapshot | null): PosAddress | null {
  return party === null ? null : { stateCode: party.address.stateCode, countryCode: party.address.countryCode };
}

/**
 * The app always names a scenario. A client that does not gets what it effectively asked for: a
 * declared export or SEZ supply as declared, a known other state as a delivery there, and otherwise
 * a sale over the counter.
 */
function resolveUndeclared(
  body: CreateInvoiceBody,
  buyer: PartySnapshot | null,
  supplierState: string,
): { scenario: SupplyScenario; result: PosResult; sezAuthorisedOperations: boolean | null } {
  const placeOfSupply = body.placeOfSupplyStateCode ?? buyer?.address.stateCode ?? supplierState;
  const declared = body.supplyType;
  const reason = 'scenario_not_declared';
  if (declared === 'export_with_tax' || declared === 'export_without_tax') {
    return {
      scenario: declared === 'export_with_tax' ? 'export_goods_with_payment' : 'export_goods_under_lut',
      result: { placeOfSupply, supplyType: declared, provision: 'igst_11', reason },
      sezAuthorisedOperations: null,
    };
  }
  if (declared === 'sez_with_tax' || declared === 'sez_without_tax') {
    return {
      scenario: 'supply_to_sez',
      result: { placeOfSupply, supplyType: declared, provision: 'igst_7_5_b', reason },
      sezAuthorisedOperations: true,
    };
  }
  const elsewhere = placeOfSupply !== supplierState;
  return {
    scenario: elsewhere ? 'delivered' : 'counter_sale',
    result: {
      placeOfSupply,
      supplyType: elsewhere ? 'inter_state' : 'intra_state',
      provision: elsewhere ? 'igst_10_1_a' : 'igst_10_1_c',
      reason,
    },
    sezAuthorisedOperations: null,
  };
}

function assertAgrees(body: CreateInvoiceBody, result: PosResult): void {
  const placeDiffers = body.placeOfSupplyStateCode !== undefined && body.placeOfSupplyStateCode !== result.placeOfSupply;
  const typeDiffers = body.supplyType !== undefined && body.supplyType !== result.supplyType;
  if (placeDiffers || typeDiffers) {
    throw new UnprocessableError(
      'The place of supply on this invoice does not follow from its scenario and addresses.',
      ErrorCode.PLACE_OF_SUPPLY_MISMATCH,
      {
        details: {
          sent: { placeOfSupply: body.placeOfSupplyStateCode, supplyType: body.supplyType },
          resolved: { placeOfSupply: result.placeOfSupply, supplyType: result.supplyType },
        },
      },
    );
  }
}

async function resolveShipTo(
  tx: Tx,
  body: CreateInvoiceBody,
  customer: CustomerRow | undefined,
  buyer: PartySnapshot | null,
): Promise<PartySnapshot | null> {
  if (body.shipToSnapshot) return body.shipToSnapshot;
  if (!body.shipToAddressId) return null;
  const address = customer ? await customersRepository.findAddress(tx, body.shipToAddressId) : undefined;
  if (!address || address.customerId !== customer?.id) {
    throw new ValidationError('The delivery address does not belong to this customer.');
  }
  return {
    name: buyer?.name ?? customer.name,
    legalName: null,
    gstin: address.shipToGstin,
    uin: null,
    gstTreatment: null,
    address: {
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      postalCode: address.postalCode,
      stateCode: address.stateCode,
      countryCode: address.countryCode,
    },
    phone: null,
    email: null,
  };
}

/** Only someone who may manage GST can move a place of supply off what the law's rules gave. */
function applyOverride(body: CreateInvoiceBody, result: PosResult, supplierState: string): {
  result: PosResult;
  override: Record<string, unknown> | null;
} {
  const requested = body.posOverride;
  if (!requested) return { result, override: null };
  const auth = requireAuthContext();
  if (!hasPermission(auth.role, 'gst:manage')) {
    throw new ForbiddenError('Only someone who manages GST can change the place of supply.');
  }
  if (result.supplyType !== 'intra_state' && result.supplyType !== 'inter_state') {
    throw new ValidationError('The place of supply of an export or SEZ supply cannot be changed.');
  }
  return {
    result: {
      placeOfSupply: requested.placeOfSupply,
      supplyType: requested.placeOfSupply === supplierState ? 'intra_state' : 'inter_state',
      provision: 'override',
      reason: 'seller_override',
    },
    override: { ...requested, by: auth.userId, at: new Date().toISOString() },
  };
}

export async function decideInvoiceSupply(
  tx: Tx,
  input: {
    readonly body: CreateInvoiceBody;
    readonly mode: TaxMode;
    readonly customer: CustomerRow | undefined;
    readonly supplierState: string;
  },
): Promise<InvoiceSupply> {
  const { body, mode, customer, supplierState } = input;
  // What the till showed when offline wins over a customer edited since: it is what the buyer holds.
  const buyer = body.buyerSnapshot ?? (customer ? customerSnapshot(customer) : null);
  if (!customer && buyer?.gstin) {
    throw new ValidationError('A registered buyer must be saved as a customer before billing.');
  }
  const shipTo = await resolveShipTo(tx, body, customer, buyer);

  if (mode !== 'gst') {
    return {
      scenario: null,
      provision: null,
      override: null,
      resolvedPlaceOfSupply: body.placeOfSupplyStateCode,
      sezAuthorisedOperations: null,
      placeOfSupply: body.placeOfSupplyStateCode,
      supplyType: body.supplyType,
      buyer,
      shipTo,
    };
  }

  const decided = body.supplyScenario
    ? {
        scenario: body.supplyScenario,
        result: resolvePlaceOfSupply({
          scenario: body.supplyScenario,
          supplierStateCode: supplierState,
          buyerTreatment: buyer?.gstTreatment ?? null,
          billTo: posAddress(buyer),
          shipTo: posAddress(shipTo),
          goodsLocationStateCode: body.goodsLocationStateCode ?? null,
          sezAuthorisedOperations: body.sezAuthorisedOperations ?? null,
          sezUnderLut: body.sezUnderLut ?? null,
        }),
        sezAuthorisedOperations: body.supplyScenario === 'supply_to_sez' ? (body.sezAuthorisedOperations ?? null) : null,
      }
    : resolveUndeclared(body, buyer, supplierState);

  const { result, override } = applyOverride(body, decided.result, supplierState);
  assertAgrees(body, result);
  return {
    scenario: decided.scenario,
    provision: result.provision,
    override,
    resolvedPlaceOfSupply: decided.result.placeOfSupply,
    sezAuthorisedOperations: decided.sezAuthorisedOperations,
    placeOfSupply: result.placeOfSupply,
    supplyType: result.supplyType,
    buyer,
    shipTo,
  };
}

/** Rule 46: a tax invoice missing what the rule requires is not issued. */
export function assertRule46(input: {
  readonly documentType: GstDocumentType | null;
  readonly supplyType: SupplyType;
  readonly supply: InvoiceSupply;
  readonly taxableValue: number;
}): void {
  const missing = rule46MissingFields({
    documentType: input.documentType,
    supplyType: input.supplyType,
    buyer: input.supply.buyer,
    shipTo: input.supply.shipTo,
    taxableValue: input.taxableValue,
    unregisteredThreshold: RULE_46_UNREGISTERED_TAXABLE_PAISE,
  });
  if (missing.length > 0) {
    throw new UnprocessableError(
      'This tax invoice is missing details Rule 46 requires.',
      ErrorCode.RULE_46_DETAILS_MISSING,
      { details: { missing } },
    );
  }
}
