import { z } from 'zod';
import { OBJECT_KINDS } from '../../lib/storage.js';

export const signUploadBody = z.object({
  kind: z.enum(OBJECT_KINDS),
  contentType: z.string().min(1).max(100),
  /** What the client intends to upload; checked against the per-kind limit. */
  sizeBytes: z.number().int().positive(),
});
export type SignUploadBody = z.infer<typeof signUploadBody>;

export const downloadUrlQuery = z.object({
  // Not a uuid: the key is `{tenantId}/{kind}/{uuid}.{ext}` and is verified
  // against the caller's own tenant prefix before it is used.
  key: z.string().min(1).max(512),
});
export type DownloadUrlQuery = z.infer<typeof downloadUrlQuery>;
