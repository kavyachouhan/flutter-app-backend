import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { gstin, nonEmpty, paise, signedPaise, stateCode } from '../../lib/validators.js';

const customerFields = {
  name: nonEmpty,
  phone: nonEmpty.nullable().optional(),
  email: z.string().email().nullable().optional(),
  gstin: gstin.nullable().optional(),
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

export const listCustomersQuery = pageQuery.extend({ q: nonEmpty.optional() });
export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;

export const ledgerQuery = pageQuery;
