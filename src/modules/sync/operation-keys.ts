/**
 * Idempotency keys for pushed operations (table `operation_keys`, migration 0035).
 *
 * The key is the device's own `opId`. It is claimed inside the same transaction as the
 * operation's effects (see `runInTransactionScope`), which is what makes the guarantee exact:
 *
 *  - committed effects  <=>  a key row exists, so a repeat is answered from the row and does
 *    nothing;
 *  - rolled-back effects  =>  no key row, so a retry runs the operation fresh;
 *  - two copies of the same operation arriving together: the second INSERT waits for the first
 *    transaction to finish, then finds the row — it can never run the effects a second time.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import type { Tx } from '../../db/tx.js';
import { withTransaction } from '../../db/tx.js';
import { ConflictError, ErrorCode } from '../../lib/errors.js';

/** What the first call returned, replayed to a repeat. Small on purpose: ids and warnings only. */
export interface StoredResult {
  id?: string;
  warnings?: unknown[];
  mergedInto?: unknown;
}

export type Claim = { kind: 'new' } | { kind: 'replay'; result: StoredResult };

/** JSON with object keys in a fixed order, so the same payload always hashes the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** What an opId is bound to: the operation type and exactly what was sent. */
export function payloadHash(type: string, payload: unknown): Buffer {
  return createHash('sha256').update(`${type}\n${canonical(payload)}`).digest();
}

export interface ClaimInput {
  opId: string;
  deviceId: string;
  userId: string | undefined;
  type: string;
  hash: Buffer;
}

/**
 * Claims [input.opId] for this operation. Must run inside the transaction that will hold the
 * operation's effects. Returns `replay` (with the first call's result) when the operation was
 * already applied; throws OPERATION_KEY_REUSED when the opId was used for something else.
 */
export async function claimOperationKey(tx: Tx, input: ClaimInput): Promise<Claim> {
  const inserted = await tx.one(
    `INSERT INTO operation_keys (tenant_id, op_id, device_id, user_id, op_type, payload_hash, expires_at)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, now() + make_interval(days => $6::int))
     ON CONFLICT (tenant_id, op_id) DO NOTHING
     RETURNING op_id`,
    [
      input.opId,
      input.deviceId,
      input.userId ?? null,
      input.type,
      input.hash,
      env.SYNC_OPERATION_KEY_TTL_DAYS,
    ],
  );
  if (inserted) return { kind: 'new' };

  const existing = await tx.one<{ op_type: string; payload_hash: Buffer; result: StoredResult }>(
    'SELECT op_type, payload_hash, result FROM operation_keys WHERE op_id = $1',
    [input.opId],
  );
  // Gone between the insert and the read (purged in that instant): treat it as never seen.
  if (!existing) return { kind: 'new' };
  if (existing.op_type !== input.type || !existing.payload_hash.equals(input.hash)) {
    throw new ConflictError(
      'This operation id was already used for a different operation.',
      ErrorCode.OPERATION_KEY_REUSED,
      { details: { opId: input.opId } },
    );
  }
  return { kind: 'replay', result: existing.result };
}

/** Stores what the operation returned, in the same transaction as its effects. */
export async function completeOperationKey(
  tx: Tx,
  opId: string,
  result: StoredResult,
): Promise<void> {
  await tx.query('UPDATE operation_keys SET result = $2::jsonb WHERE op_id = $1', [
    opId,
    JSON.stringify(result),
  ]);
}

/** Deletes expired keys for the current tenant in a small batch. Returns how many went. */
export async function purgeExpiredKeys(limit = 500): Promise<number> {
  return withTransaction(async (tx) => {
    const res = await tx.query(
      `DELETE FROM operation_keys
       WHERE ctid IN (SELECT ctid FROM operation_keys WHERE expires_at < now() LIMIT $1)`,
      [limit],
    );
    return res.rowCount ?? 0;
  });
}
