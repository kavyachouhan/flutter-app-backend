import { z } from 'zod';
import { clientId } from '../../lib/ids.js';
import { pageQuery } from '../../lib/pagination.js';
import { booleanQuery, isoDate, nonEmpty, quantity } from '../../lib/validators.js';

export const createDeliveryChallanBody = z.object({
  id: clientId,
  outletId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
  documentDate: isoDate,
  notes: nonEmpty.max(500).optional(),
  lines: z
    .array(
      z.object({
        id: clientId,
        itemId: z.string().uuid(),
        /** Snapshot: the item's own name at the moment of dispatch. */
        itemName: nonEmpty.optional(),
        unit: nonEmpty.optional(),
        quantity,
      }),
    )
    .min(1)
    .max(500),
});
export type CreateDeliveryChallanBody = z.infer<typeof createDeliveryChallanBody>;

export const listDeliveryChallansQuery = pageQuery.extend({
  customerId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  status: z.enum(['open', 'partial', 'converted', 'cancelled']).optional(),
  /** open or partial: still owed, in part or in full. */
  openOnly: booleanQuery.optional(),
  /** converted or cancelled: nothing more will happen to it. */
  closedOnly: booleanQuery.optional(),
});
export type ListDeliveryChallansQuery = z.infer<typeof listDeliveryChallansQuery>;

export const cancelDeliveryChallanBody = z.object({ reason: nonEmpty.max(200) });
export type CancelDeliveryChallanBody = z.infer<typeof cancelDeliveryChallanBody>;

/**
 * A challan carries no GST/legal weight like an invoice does, so a mistake
 * (wrong quantity, wrong item, a line that should not be there) is fixed by
 * editing in place rather than cancel-and-reissue — but only while nothing
 * on it has been invoiced yet (enforced in the service, not here).
 *
 * `documentDate` is deliberately not editable: it decided which numbering
 * series the document number was already allocated from, and changing it
 * after the fact would leave the number pointing at the wrong financial year.
 */
export const updateDeliveryChallanBody = z.object({
  customerId: z.string().uuid().nullable(),
  notes: nonEmpty.max(500).nullable(),
  lines: z
    .array(
      z.object({
        id: clientId,
        itemId: z.string().uuid(),
        itemName: nonEmpty.optional(),
        unit: nonEmpty.optional(),
        quantity,
      }),
    )
    .min(1)
    .max(500),
});
export type UpdateDeliveryChallanBody = z.infer<typeof updateDeliveryChallanBody>;
