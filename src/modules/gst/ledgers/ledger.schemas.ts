import { z } from 'zod';
import { clientId } from '../../../lib/ids.js';
import { gstin } from '../../../lib/validators.js';
import { LEDGER_KINDS } from '../../../domain/gst/ledgers/types.js';

/**
 * A ledger file as the portal produced it, sent as the request body. Ledger files are small (a
 * year of entries is far below the body limit), so no upload step is needed and a file is either
 * taken whole or refused.
 */
export const importLedgerBody = z.object({
  id: clientId,
  /** Omitted, the business's own GSTIN is used; a business with several must name one. */
  gstin: gstin.optional(),
  kind: z.enum(LEDGER_KINDS),
  document: z.record(z.unknown()),
});
export type ImportLedgerBody = z.infer<typeof importLedgerBody>;

export const listLedgerImportsQuery = z.object({
  gstin: gstin.optional(),
});
export type ListLedgerImportsQuery = z.infer<typeof listLedgerImportsQuery>;
