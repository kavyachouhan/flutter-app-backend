import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { gstin, nonEmpty, shortCode, stateCode } from '../../lib/validators.js';

const outletFields = {
  name: nonEmpty,
  code: shortCode,
  gstin: gstin.nullable().optional(),
  stateCode: stateCode.nullable().optional(),
  addressLine1: nonEmpty.nullable().optional(),
  addressLine2: nonEmpty.nullable().optional(),
  city: nonEmpty.nullable().optional(),
  pincode: nonEmpty.nullable().optional(),
  phone: nonEmpty.nullable().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
};

export const createOutletBody = z.object({ id: clientId, ...outletFields });
export type CreateOutletBody = z.infer<typeof createOutletBody>;

export const updateOutletBody = z.object(outletFields).partial();
export type UpdateOutletBody = z.infer<typeof updateOutletBody>;

const counterFields = {
  name: nonEmpty,
  code: shortCode,
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
};

export const createCounterBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  ...counterFields,
});
export type CreateCounterBody = z.infer<typeof createCounterBody>;

export const updateCounterBody = z.object(counterFields).partial();
export type UpdateCounterBody = z.infer<typeof updateCounterBody>;

export const listCountersQuery = z.object({ outletId: z.string().uuid().optional() });
