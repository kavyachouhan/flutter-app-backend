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

/** RBI's fixed format: 4-letter bank code, a literal '0', 6-char branch code. */
export const ifsc = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'must be a valid IFSC code');

/**
 * No single length is correct across Indian banks (SBI 11, HDFC 14, ICICI 12,
 * some co-operative banks fewer) — this is a sanity bound, not a real format.
 */
export const bankAccountNumber = z
  .string()
  .trim()
  .regex(/^[0-9]{9,18}$/, 'must be 9-18 digits');

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

/**
 * Cash always means the one Cash In-Hand account — nothing to choose. Any
 * other tender mode has to say which bank account the money moved through,
 * so the Cash & Bank ledger knows where to put it.
 */
export function requireAccountForNonCashMode(
  obj: { mode: string; accountId?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (obj.mode !== 'cash' && !obj.accountId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accountId'],
      message: 'Choose which account this payment moved through.',
    });
  }
}

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
