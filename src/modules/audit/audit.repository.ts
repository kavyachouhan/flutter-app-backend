import type { Tx } from '../../db/tx.js';
import type { Cursor } from '../../lib/pagination.js';
import type { FieldChanges } from './audit.js';

export interface AuditRow {
  /** BIGSERIAL, rendered as text: it outlives Number.MAX_SAFE_INTEGER and clients only echo it. */
  id: string;
  occurredAt: Date;
  userId: string | null;
  deviceId: string | null;
  ip: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: FieldChanges | null;
  metadata: Record<string, unknown> | null;
  requestId: string | null;
}

export interface AuditFilter {
  entityType: string | undefined;
  entityId: string | undefined;
  action: string | undefined;
  userId: string | undefined;
  from: string | undefined;
  to: string | undefined;
}

const COLUMNS = `
  e.id::text AS id, e.occurred_at AS "occurredAt", e.user_id AS "userId", e.device_id AS "deviceId",
  e.ip::text AS ip, e.action, e.entity_type AS "entityType", e.entity_id AS "entityId",
  e.changes, e.metadata, e.request_id AS "requestId"`;

export const auditRepository = {
  /**
   * Newest first, which is how an owner reads an audit trail. The keyset
   * comparison is therefore `<`, and it matches audit_log_tenant_time_idx.
   */
  list(
    tx: Tx,
    filter: AuditFilter,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<AuditRow[]> {
    return tx.many<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_log e
       WHERE ($1::text IS NULL OR e.entity_type = $1)
         AND ($2::uuid IS NULL OR e.entity_id = $2)
         AND ($3::text IS NULL OR e.action = $3)
         AND ($4::uuid IS NULL OR e.user_id = $4)
         AND ($5::timestamptz IS NULL OR e.occurred_at >= $5)
         AND ($6::timestamptz IS NULL OR e.occurred_at < $6)
         AND ($7::timestamptz IS NULL OR (e.occurred_at, e.id) < ($7::timestamptz, $8::bigint))
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT $9`,
      [
        filter.entityType ?? null,
        filter.entityId ?? null,
        filter.action ?? null,
        filter.userId ?? null,
        filter.from ?? null,
        filter.to ?? null,
        cursor ? String(cursor.k) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
  },
};
