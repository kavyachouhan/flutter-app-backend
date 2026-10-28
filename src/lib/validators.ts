/** Reusable Zod fields. Formats here are defined by GST law or ISO standards. */
import { z } from 'zod';
import { env } from '../config/env.js';

export const nonEmpty = z.string().trim().min(1);

/**
 * A storage object key, as returned by `/uploads/sign`. Only its shape is
 * checked here; the service also proves it sits under the caller's own tenant
 * prefix and was signed for the right kind (see `assertKeyHasKind`).
 */
export const objectKey = z.string().min(1).max(512);

/** The name of an icon the app bundles, e.g. `shopping-cart`. Not a path and not a URL. */
export const iconName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'must be an icon name');

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

/**
 * How a line is classified for the GST return. One definition, shared by every
 * document type, because a sale, a return and a purchase are reported out of
 * the same four buckets and a divergence between them would be a filing error
 * nobody could see.
 *
 * Optional everywhere on the wire and absent means `taxable`, so an installed
 * app that predates classification keeps uploading.
 */
export const SUPPLY_CATEGORIES = ['taxable', 'exempt', 'nil_rated', 'non_gst'] as const;
export const supplyCategory = z.enum(SUPPLY_CATEGORIES);

/**
 * Supply types a caller may declare. The two state-based ones are derived from
 * the place of supply and need not be sent; the export and SEZ ones cannot be
 * derived from anything, so only the caller can say.
 */
export const DECLARABLE_SUPPLY_TYPES = [
  'inter_state',
  'export_with_tax',
  'export_without_tax',
  'sez_with_tax',
  'sez_without_tax',
] as const;
export const declaredSupplyType = z.enum(DECLARABLE_SUPPLY_TYPES);
