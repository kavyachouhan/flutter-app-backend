import { z } from 'zod';
import { nonEmpty } from '../../lib/validators.js';

export const deviceInput = z.object({
  deviceKey: nonEmpty,
  platform: z.enum(['android', 'ios', 'windows', 'macos', 'web']),
  label: nonEmpty.optional(),
  appVersion: nonEmpty.optional(),
  osVersion: nonEmpty.optional(),
});
export type DeviceInput = z.infer<typeof deviceInput>;

export const otpRequestBody = z.object({ phone: nonEmpty });

export const otpVerifyBody = z.object({ phone: nonEmpty, code: z.string().regex(/^\d+$/) });

export const createSessionBody = z.object({ tenantId: z.string().uuid(), device: deviceInput });

export const refreshBody = z.object({ refreshToken: nonEmpty });

export const logoutBody = z.object({ allDevices: z.boolean().optional() });

export const devLoginBody = z
  .object({
    phone: nonEmpty,
    name: nonEmpty.optional(),
    tenantId: z.string().uuid().optional(),
    device: deviceInput.optional(),
  })
  .refine((body) => !body.tenantId || body.device, {
    message: 'device is required when tenantId is given',
    path: ['device'],
  });
export type DevLoginBody = z.infer<typeof devLoginBody>;
