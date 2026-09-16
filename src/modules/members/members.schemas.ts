import { z } from 'zod';
import { nonEmpty } from '../../lib/validators.js';
import { ROLES } from '../auth/permissions.js';

/** null grants every outlet; an array confines the member to those outlets. */
const outletIds = z.array(z.string().uuid()).nonempty().nullable();

export const addMemberBody = z.object({
  phone: nonEmpty,
  name: nonEmpty.optional(),
  role: z.enum(ROLES),
  outletIds,
});
export type AddMemberBody = z.infer<typeof addMemberBody>;

export const updateMemberBody = z.object({
  role: z.enum(ROLES).optional(),
  outletIds: outletIds.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateMemberBody = z.infer<typeof updateMemberBody>;
