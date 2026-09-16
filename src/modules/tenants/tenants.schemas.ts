import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { gstin, nonEmpty, pan, shortCode, stateCode } from '../../lib/validators.js';
import { deviceInput } from '../auth/auth.schemas.js';

const profileFields = {
  name: nonEmpty,
  legalName: nonEmpty.nullable().optional(),
  isGstRegistered: z.boolean(),
  gstin: gstin.nullable().optional(),
  isComposition: z.boolean().optional(),
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
