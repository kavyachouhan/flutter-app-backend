import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { GST_TREATMENTS } from '../../domain/gst/enums.js';
import { countryCode, gstin, nonEmpty, paise, signedPaise, stateCode, uin } from '../../lib/validators.js';

const customerFields = {
  name: nonEmpty,
  phone: nonEmpty.nullable().optional(),
  email: z.string().email().nullable().optional(),
  gstin: gstin.nullable().optional(),
  /** Omitted, it follows the GSTIN, UIN and country. */
  gstTreatment: z.enum(GST_TREATMENTS).optional(),
  uin: uin.nullable().optional(),
  countryCode: countryCode.optional(),
  stateCode: stateCode.nullable().optional(),
  addressLine1: nonEmpty.nullable().optional(),
  addressLine2: nonEmpty.nullable().optional(),
  city: nonEmpty.nullable().optional(),
  pincode: nonEmpty.nullable().optional(),
  /** null means no limit. */
  creditLimit: paise.nullable().optional(),
  /**
   * Which price list this customer is billed at. Null takes the tenant
   * default, which is how a retail walk-in and an unassigned customer end up
   * priced the same way.
   */
  priceListId: z.string().uuid().nullable().optional(),
  notes: nonEmpty.nullable().optional(),
};

export const createCustomerBody = z.object({
  id: clientId,
  ...customerFields,
  /** Positive: the customer already owes this much. Negative: an advance held. */
  openingBalance: signedPaise.optional(),
});
export type CreateCustomerBody = z.infer<typeof createCustomerBody>;

export const updateCustomerBody = z.object(customerFields).partial();
export type UpdateCustomerBody = z.infer<typeof updateCustomerBody>;

const addressFields = {
  label: nonEmpty.max(60).nullable().optional(),
  line1: nonEmpty,
  line2: nonEmpty.nullable().optional(),
  city: nonEmpty,
  countryCode: countryCode.optional(),
  stateCode: stateCode.nullable().optional(),
  postalCode: nonEmpty.max(16).nullable().optional(),
  /** Optional: the e-way bill mandate for it is on hold. */
  shipToGstin: gstin.nullable().optional(),
  isDefault: z.boolean().optional(),
};

/** Sent whole, so an offline device's last edit simply replaces the row. */
export const upsertCustomerAddressBody = z.object({
  id: clientId,
  customerId: z.string().uuid(),
  ...addressFields,
});
export type UpsertCustomerAddressBody = z.infer<typeof upsertCustomerAddressBody>;

export const customerAddressParams = z.object({ id: z.string().uuid(), addressId: z.string().uuid() });

export const listCustomersQuery = pageQuery.extend({ q: nonEmpty.optional() });
export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;

export const ledgerQuery = pageQuery;
