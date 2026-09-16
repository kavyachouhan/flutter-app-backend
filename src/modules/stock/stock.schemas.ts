import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { booleanQuery, nonEmpty, signedQuantity, timestamp } from '../../lib/validators.js';

export const REASON_CODES = [
  'damage',
  'theft',
  'expiry',
  'count_correction',
  'opening',
  'other',
] as const;

export const listBalancesQuery = pageQuery.extend({
  outletId: z.string().uuid(),
  itemId: z.string().uuid().optional(),
  belowReorder: booleanQuery.optional(),
});
export type ListBalancesQuery = z.infer<typeof listBalancesQuery>;

export const ledgerQuery = pageQuery.extend({
  outletId: z.string().uuid(),
  itemId: z.string().uuid(),
});
export type LedgerQuery = z.infer<typeof ledgerQuery>;

export const createAdjustmentBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  itemId: z.string().uuid(),
  /** Thousandths of a unit; negative removes stock. */
  quantityDelta: signedQuantity,
  reasonCode: z.enum(REASON_CODES),
  note: nonEmpty.optional(),
  occurredAt: timestamp,
});
export type CreateAdjustmentBody = z.infer<typeof createAdjustmentBody>;
