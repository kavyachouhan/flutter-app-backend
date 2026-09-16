import type { Tx } from '../../db/tx.js';
import { getContext } from '../../lib/context.js';
import { jsonParam } from '../../db/sql.js';

export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: FieldChanges | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const context = getContext();
  await tx.query(
    `INSERT INTO audit_log (tenant_id, user_id, device_id, ip, action, entity_type, entity_id, changes, metadata, request_id)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      context?.userId ?? null,
      context?.deviceId ?? null,
      context?.ip ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      jsonParam(entry.changes),
      jsonParam(entry.metadata),
      context?.requestId ?? null,
    ],
  );
}

/** Fields in `patch` whose value differs from `before`; null when nothing changed. */
export function diffFields(before: object, patch: object): FieldChanges | null {
  const current = before as Record<string, unknown>;
  const changes: FieldChanges = {};
  for (const [key, to] of Object.entries(patch)) {
    if (to === undefined) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(to)) {
      changes[key] = { from: current[key], to };
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}
