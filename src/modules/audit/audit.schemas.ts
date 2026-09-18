import { z } from 'zod';
import { pageQuery } from '../../lib/pagination.js';
import { nonEmpty, timestamp } from '../../lib/validators.js';

export const listAuditQuery = pageQuery.extend({
  entityType: nonEmpty.optional(),
  entityId: z.string().uuid().optional(),
  action: nonEmpty.optional(),
  userId: z.string().uuid().optional(),
  /** Inclusive. */
  from: timestamp.optional(),
  /** Exclusive, so consecutive windows neither overlap nor skip an entry. */
  to: timestamp.optional(),
});
export type ListAuditQuery = z.infer<typeof listAuditQuery>;
