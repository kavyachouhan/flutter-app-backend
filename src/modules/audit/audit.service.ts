import { withReadTransaction } from '../../db/tx.js';
import { buildPage, parsePage } from '../../lib/pagination.js';
import { auditRepository } from './audit.repository.js';
import type { ListAuditQuery } from './audit.schemas.js';

export async function listAudit(query: ListAuditQuery) {
  const page = parsePage(query);
  const rows = await withReadTransaction((tx) =>
    auditRepository.list(
      tx,
      {
        entityType: query.entityType,
        entityId: query.entityId,
        action: query.action,
        userId: query.userId,
        from: query.from,
        to: query.to,
      },
      page.limit,
      page.cursor,
    ),
  );
  return buildPage(rows, page.limit, (row) => ({ k: row.occurredAt.toISOString(), id: row.id }));
}
