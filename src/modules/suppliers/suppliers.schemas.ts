import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { GST_TREATMENTS } from '../../domain/gst/enums.js';
import { booleanQuery, countryCode, gstin, nonEmpty, signedPaise, stateCode, uin } from '../../lib/validators.js';

const supplierFields = {
  name: nonEmpty,
  phone: nonEmpty.nullable().optional(),
  email: z.string().email().nullable().optional(),
  gstin: gstin.nullable().optional(),
  /** Omitted, it follows the GSTIN, UIN and country. */
  gstTreatment: z.enum(GST_TREATMENTS).optional(),
  uin: uin.nullable().optional(),
  countryCode: countryCode.optional(),
  /** Place of supply for a purchase: decides IGST versus CGST/SGST. */
  stateCode: stateCode.nullable().optional(),
  addressLine1: nonEmpty.nullable().optional(),
  addressLine2: nonEmpty.nullable().optional(),
  city: nonEmpty.nullable().optional(),
  pincode: nonEmpty.nullable().optional(),
  /** Days from bill date to due date; drives the ageing buckets. */
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: nonEmpty.nullable().optional(),
  isActive: z.boolean().optional(),
};

export const createSupplierBody = z.object({
  id: clientId,
  ...supplierFields,
  /** Positive: the shop already owes this much. Negative: an advance paid. */
  openingBalance: signedPaise.optional(),
});
export type CreateSupplierBody = z.infer<typeof createSupplierBody>;

export const updateSupplierBody = z.object(supplierFields).partial();
export type UpdateSupplierBody = z.infer<typeof updateSupplierBody>;

export const listSuppliersQuery = pageQuery.extend({
  q: nonEmpty.optional(),
  includeInactive: booleanQuery.optional(),
});
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuery>;

export const supplierStatementQuery = pageQuery;
