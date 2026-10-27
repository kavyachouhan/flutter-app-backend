import { z } from 'zod';
import { TEMPLATE_KEYS } from '../../domain/print/templates.js';
import { booleanQuery, nonEmpty } from '../../lib/validators.js';

export const CUSTOM_FIELD_DOCUMENT_TYPES = [
  'invoice',
  'credit_note',
  'estimate',
  'sales_order',
] as const;
export const CUSTOM_FIELD_DATA_TYPES = ['text', 'number', 'date', 'boolean'] as const;

/**
 * `?copyIndex=` picks which of the template's GST rule-48 copies this is;
 * `?template=` lets a till print an A4 tax invoice for a B2B customer without
 * the tenant changing their counter default.
 */
export const printPayloadQuery = z.object({
  copyIndex: z.coerce.number().int().min(0).max(9).optional(),
  template: z.enum(TEMPLATE_KEYS).optional(),
});
export type PrintPayloadQuery = z.infer<typeof printPayloadQuery>;

/** The literal `default` addresses the tenant-wide profile. */
export const printProfileParams = z.object({
  outletId: z.union([z.literal('default'), z.string().uuid()]),
});

const lines = (max: number) => z.array(z.string().trim().max(200)).max(max);

export const upsertPrintProfileBody = z.object({
  templateKey: z.enum(TEMPLATE_KEYS).optional(),
  // Nullable, not just optional: null is how a tenant clears an override and
  // goes back to inheriting the template's own decision.
  showHsn: z.boolean().nullable().optional(),
  showTaxColumn: z.boolean().nullable().optional(),
  showTaxSummary: z.boolean().nullable().optional(),
  showAmountInWords: z.boolean().nullable().optional(),
  showSignature: z.boolean().nullable().optional(),
  logoObjectKey: z.string().max(512).nullable().optional(),
  signatureObjectKey: z.string().max(512).nullable().optional(),
  signatureLabel: z.string().trim().max(100).nullable().optional(),
  upiId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/, 'must be a valid UPI ID')
    .nullable()
    .optional(),
  bankLines: lines(10).optional(),
  termsLines: lines(20).optional(),
  footerLines: lines(10).optional(),
  // https only: the QR on a printed bill is scanned by strangers, and a
  // plain-http lookup page is a credential-harvesting opportunity.
  lookupBaseUrl: z.string().url().startsWith('https://').max(300).nullable().optional(),
});
export type UpsertPrintProfileBody = z.infer<typeof upsertPrintProfileBody>;

export const listCustomFieldsQuery = z.object({
  includeInactive: booleanQuery.optional(),
});
export type ListCustomFieldsQuery = z.infer<typeof listCustomFieldsQuery>;

export const createCustomFieldBody = z
  .object({
    /** A wire identifier older installed apps keep sending, so it is constrained and permanent. */
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, 'must be lowercase letters, digits and underscores'),
    label: nonEmpty.max(60),
    dataType: z.enum(CUSTOM_FIELD_DATA_TYPES),
    isRequired: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(999).default(0),
    documentTypes: z.array(z.enum(CUSTOM_FIELD_DOCUMENT_TYPES)).min(1),
    maxLength: z.number().int().min(1).max(500).optional(),
    placeholder: z.string().trim().max(100).optional(),
  })
  .refine((v) => v.maxLength === undefined || v.dataType === 'text', {
    message: 'maxLength applies to text fields only',
    path: ['maxLength'],
  });
export type CreateCustomFieldBody = z.infer<typeof createCustomFieldBody>;

/** `key` is absent on purpose: issued documents already carry it. */
export const updateCustomFieldBody = z.object({
  label: nonEmpty.max(60).optional(),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  documentTypes: z.array(z.enum(CUSTOM_FIELD_DOCUMENT_TYPES)).min(1).optional(),
  maxLength: z.number().int().min(1).max(500).nullable().optional(),
  placeholder: z.string().trim().max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCustomFieldBody = z.infer<typeof updateCustomFieldBody>;
