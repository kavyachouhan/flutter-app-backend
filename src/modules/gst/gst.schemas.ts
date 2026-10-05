import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { gstin, isoDate, nonEmpty } from '../../lib/validators.js';

export const RETURN_TYPES = ['gstr1', 'gstr3b', 'cmp08'] as const;
export const RETURN_STATUSES = ['open', 'prepared', 'filed'] as const;
export const ITC_CATEGORIES = ['inputs', 'input_services', 'capital_goods', 'ineligible'] as const;
export const ITC_STATES = ['available', 'claimed', 'reversed', 'ineligible'] as const;
export const MATCH_TYPES = [
  'exact',
  'probable',
  'missing_in_books',
  'missing_in_2b',
  'mismatch',
] as const;

const periodYear = z.coerce.number().int().min(2017).max(2100);
const periodMonth = z.coerce.number().int().min(1).max(12);

export const listPeriodsQuery = pageQuery.extend({
  gstin: gstin.optional(),
  returnType: z.enum(RETURN_TYPES).optional(),
  status: z.enum(RETURN_STATUSES).optional(),
});
export type ListPeriodsQuery = z.infer<typeof listPeriodsQuery>;

/**
 * Opens a period for working on. Creating it computes nothing: `prepare` does
 * that, and only then can it be filed.
 */
export const createPeriodBody = z.object({
  id: clientId,
  /** Omitted, the business's own GSTIN is used. */
  gstin: gstin.optional(),
  returnType: z.enum(RETURN_TYPES),
  periodYear,
  /** For a quarterly return, the quarter's last month. */
  periodMonth,
});
export type CreatePeriodBody = z.infer<typeof createPeriodBody>;

/**
 * Marks a prepared return as filed. Never automatic, and never inferred from
 * anything: the figures are the shop's declaration to the department, so
 * somebody has to say they have been filed, and that someone is recorded.
 */
export const filePeriodBody = z.object({
  /** The portal's acknowledgement number, which is the only proof of filing. */
  arn: nonEmpty.max(64).optional(),
  notes: nonEmpty.max(500).optional(),
  /**
   * Must be true. A deliberate speed bump rather than validation theatre: an
   * accidental POST to this path would otherwise record a filing that never
   * happened, and the next period's workings would build on it.
   */
  confirm: z.literal(true),
});
export type FilePeriodBody = z.infer<typeof filePeriodBody>;

export const itcRegisterQuery = pageQuery.extend({
  gstin: gstin.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  state: z.enum(ITC_STATES).optional(),
  itcCategory: z.enum(ITC_CATEGORIES).optional(),
  supplierId: z.string().uuid().optional(),
});
export type ItcRegisterQuery = z.infer<typeof itcRegisterQuery>;

/**
 * Registers a GSTR-2B download. The bytes go straight to storage on the
 * returned signed URL, as with the catalogue importer — they never pass
 * through this API.
 */
export const createGstr2bImportBody = z.object({
  id: clientId,
  gstin: gstin.optional(),
  periodYear,
  periodMonth,
  /** The portal offers the statement as JSON and as a spreadsheet. */
  format: z.enum(['json', 'xlsx']).default('json'),
  originalFilename: nonEmpty.max(200).optional(),
  contentType: nonEmpty,
  sizeBytes: z.number().int().positive(),
});
export type CreateGstr2bImportBody = z.infer<typeof createGstr2bImportBody>;

export const listMatchesQuery = pageQuery.extend({
  matchType: z.enum(MATCH_TYPES).optional(),
});
export type ListMatchesQuery = z.infer<typeof listMatchesQuery>;

/**
 * Confirms a probable match a human has looked at.
 *
 * Only ever a human action. A probable match is two documents that look alike
 * but are numbered differently; accepting one wrongly claims credit against
 * somebody else's invoice, which is the error this whole feature exists to
 * prevent.
 */
export const acceptMatchBody = z.object({
  note: nonEmpty.max(280).optional(),
});
export type AcceptMatchBody = z.infer<typeof acceptMatchBody>;

export const listImportsQuery = pageQuery;
