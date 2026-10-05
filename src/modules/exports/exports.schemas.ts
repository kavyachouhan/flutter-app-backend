import { z } from 'zod';
import { LABEL_TEMPLATE_KEYS } from '../../domain/labels/templates.js';
import { isoDate } from '../../lib/validators.js';

export const EXPORT_KINDS = ['items', 'customers', 'stock', 'invoices'] as const;

export const createExportBody = z
  .object({
    kind: z.enum(EXPORT_KINDS),
    /** Items only: include retired items so an archive is complete. */
    includeInactive: z.boolean().default(false),
    /** Stock only, and required for it: a balance is always per outlet. */
    outletId: z.string().uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((v) => v.kind !== 'stock' || v.outletId !== undefined, {
    message: 'outletId is required for a stock export',
    path: ['outletId'],
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'from must not be after to',
    path: ['from'],
  });
export type CreateExportBody = z.infer<typeof createExportBody>;

export const labelPayloadBody = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        copies: z.number().int().min(1).max(1000),
      }),
    )
    .min(1)
    .max(500),
  templateKey: z.enum(LABEL_TEMPLATE_KEYS),
  /** `none` prints a name-and-barcode label, for a shop that prices at the till. */
  priceField: z.enum(['mrp', 'salePrice', 'none']).default('mrp'),
});
export type LabelPayloadBody = z.infer<typeof labelPayloadBody>;
