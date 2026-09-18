/** Reusable Zod fields. Formats here are defined by GST law or ISO standards. */
import { z } from 'zod';
import { env } from '../config/env.js';

export const nonEmpty = z.string().trim().min(1);

export const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'must be a valid GSTIN');

export const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'must be a valid PAN');

export const stateCode = z.string().regex(/^[0-9]{2}$/, 'must be a two-digit GST state code');

export const hsnCode = z.string().regex(/^[0-9]{4,8}$/, 'must be a 4-8 digit HSN/SAC code');

/** Outlet and counter codes appear inside document numbers, so only GST-legal characters. */
export const shortCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]+$/, 'letters and digits only');

const safeInt = z.number().int().refine(Number.isSafeInteger, 'is out of range');

export const paise = safeInt.refine((v) => v >= 0, 'cannot be negative');
export const positivePaise = safeInt.refine((v) => v > 0, 'must be positive');
export const signedPaise = safeInt;
/** Thousandths of a unit. */
export const quantity = safeInt.refine((v) => v > 0, 'must be positive');
export const signedQuantity = safeInt.refine((v) => v !== 0, 'cannot be zero');

export const gstRate = z
  .number()
  .nonnegative()
  .refine((v) => env.GST_ALLOWED_RATES.has(v), 'is not a notified GST rate');

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(
    (v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
    'is not a real calendar date',
  );

export const timestamp = z.string().datetime({ offset: true });

export const booleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const idParams = z.object({ id: z.string().uuid() });
