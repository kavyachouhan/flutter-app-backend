import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { gstin, isoDate, nonEmpty, pan, shortCode, stateCode } from '../../lib/validators.js';
import { deviceInput } from '../auth/auth.schemas.js';

const profileFields = {
  name: nonEmpty,
  legalName: nonEmpty.nullable().optional(),
  isGstRegistered: z.boolean(),
  gstin: gstin.nullable().optional(),
  isComposition: z.boolean().optional(),
  /**
   * What the business does under the composition scheme, which decides the
   * flat rate: 1% for a trader or manufacturer, 5% for a restaurant, 6% for a
   * service provider.
   */
  compositionCategory: z
    .enum(['trader', 'manufacturer', 'restaurant', 'service'])
    .nullable()
    .optional(),
  /**
   * The rate actually used. Defaulted from the category but stored
   * separately, because the notified rates change and a CMP-08 already filed
   * must keep reporting the rate it was filed at.
   */
  compositionRatePercent: z.number().min(0).max(100).nullable().optional(),
  /** Decides which periods exist to file at all. */
  filingFrequency: z.enum(['monthly', 'qrmp']).optional(),
  /** Supplies before this date are outside GST for this business. */
  registrationEffectiveFrom: isoDate.nullable().optional(),
  pan: pan.nullable().optional(),
  stateCode,
  addressLine1: nonEmpty.nullable().optional(),
  addressLine2: nonEmpty.nullable().optional(),
  city: nonEmpty.nullable().optional(),
  pincode: nonEmpty.nullable().optional(),
  phone: nonEmpty.nullable().optional(),
  email: z.string().email().nullable().optional(),
  locale: nonEmpty.optional(),
  timezone: nonEmpty.optional(),
  currencyCode: z.string().length(3).toUpperCase().optional(),
  currencySymbol: nonEmpty.optional(),
  fyStartMonth: z.number().int().min(1).max(12).optional(),
  allowNegativeStock: z.boolean().optional(),
  defaultPricesIncludeTax: z.boolean().optional(),
};

export const createTenantBody = z.object({
  id: clientId,
  ...profileFields,
  outlet: z.object({ id: clientId, name: nonEmpty, code: shortCode }),
  counter: z.object({ id: clientId, name: nonEmpty, code: shortCode }),
  device: deviceInput,
});
export type CreateTenantBody = z.infer<typeof createTenantBody>;

export const updateTenantBody = z.object(profileFields).partial();
export type UpdateTenantBody = z.infer<typeof updateTenantBody>;
