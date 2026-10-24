import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { nonEmpty } from '../../lib/validators.js';

export const TERMS_DOCUMENT_TYPES = ['sale', 'sale_order', 'purchase', 'purchase_order'] as const;
export type TermsDocumentType = (typeof TERMS_DOCUMENT_TYPES)[number];
export const termsDocumentType = z.enum(TERMS_DOCUMENT_TYPES);

const termsFields = {
  title: nonEmpty.max(120),
  description: nonEmpty.max(2000),
  applicableFor: z
    .array(termsDocumentType)
    .min(1, 'Choose at least one document type.')
    .transform((types) => [...new Set(types)]),
};

export const createTermsBody = z.object({ id: clientId, ...termsFields });
export type CreateTermsBody = z.infer<typeof createTermsBody>;

export const updateTermsBody = z.object(termsFields).partial();
export type UpdateTermsBody = z.infer<typeof updateTermsBody>;

export const listTermsQuery = pageQuery.extend({
  applicableFor: termsDocumentType.optional(),
});
export type ListTermsQuery = z.infer<typeof listTermsQuery>;

/** What a document stores about its terms at the moment it is issued. */
export interface TermsSnapshot {
  title: string;
  description: string;
}
