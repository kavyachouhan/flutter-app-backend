import { z } from 'zod';
import { nonEmpty } from '../../lib/validators.js';

export const updateDeviceBody = z.object({
  label: nonEmpty.nullable().optional(),
  outletId: z.string().uuid().nullable().optional(),
  counterId: z.string().uuid().nullable().optional(),
});
export type UpdateDeviceBody = z.infer<typeof updateDeviceBody>;
