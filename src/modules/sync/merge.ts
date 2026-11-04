/**
 * Merging what two offline phones created or edited at the same time.
 *
 * **Creates.** Two phones each add "Asha, 98xxxxxx01" while offline. Both use their own client
 * ids, and a business keeps one customer per phone number, so the second create cannot be
 * inserted. Instead of rejecting it (which lost that phone's work and stranded the bills it had
 * queued against its own copy), the create is matched to the record that already exists, and the
 * second phone's id is remembered as an alias of it (`id_aliases`, migration 0036).
 *
 * **Aliases.** Every later operation from that phone that names the alias id is rewritten to the
 * canonical id before it is applied. Bills and payments are created after the alias exists (a
 * phone's outbox is strictly ordered), so no issued document is ever re-pointed.
 *
 * **Updates.** A phone sends only the fields it changed, plus what each one was before (`was`).
 * Per field: nobody else touched it, apply; someone did, the later one to reach the server wins
 * (the order the server receives them is the one order everybody agrees on — phone clocks are
 * not), the overwritten value goes to the audit log and the phone is told. Notes are joined, not
 * overwritten. An update without `was` (an older build) keeps the whole-row version check.
 */
import type { Tx } from '../../db/tx.js';
import { recordAudit, type FieldChanges } from '../audit/audit.js';
import { normalizePhone } from '../auth/phone.js';

export type MergeEntity = 'customer' | 'supplier' | 'item' | 'category';

export interface MergedInto {
  entity: MergeEntity;
  aliasId: string;
  canonicalId: string;
}

const CREATE_ENTITIES: Readonly<Record<string, MergeEntity>> = {
  'customer.create': 'customer',
  'supplier.create': 'supplier',
  'item.create': 'item',
  'category.create': 'category',
};

/** The update operations that carry `was` and merge field by field. */
export const FIELD_MERGE_TABLES: Readonly<Record<string, { table: string; entityType: string }>> = {
  'customer.update': { table: 'customers', entityType: 'customer' },
  'supplier.update': { table: 'suppliers', entityType: 'supplier' },
  'item.update': { table: 'items', entityType: 'item' },
  'category.update': { table: 'categories', entityType: 'category' },
};

export const mergeEntityOf = (opType: string): MergeEntity | undefined => CREATE_ENTITIES[opType];

type Json = Record<string, unknown>;

/** The table and the id column each merged kind lives in. */
const TABLES: Readonly<Record<MergeEntity, string>> = {
  customer: 'customers',
  supplier: 'suppliers',
  item: 'items',
  category: 'categories',
};

/**
 * The live record a create would collide with, matched on the same business key as its unique
 * index. The oldest wins (ids are time-ordered), so every phone converges on the same one.
 * Undefined when there is nothing to merge into — including when the create carries no key.
 */
export async function findMergeTarget(
  tx: Tx,
  entity: MergeEntity,
  payload: Json,
): Promise<string | undefined> {
  const id = payload['id'] as string;
  switch (entity) {
    case 'customer':
    case 'supplier': {
      const raw = payload['phone'];
      if (typeof raw !== 'string' || raw.trim() === '') return undefined;
      const phone = normalizePhone(raw);
      const row = await tx.one<{ id: string }>(
        `SELECT id FROM ${TABLES[entity]}
         WHERE phone = $1 AND deleted_at IS NULL AND id <> $2 ORDER BY id LIMIT 1`,
        [phone, id],
      );
      return row?.id;
    }
    case 'item': {
      const code = payload['code'];
      if (typeof code !== 'string' || code.trim() === '') return undefined;
      const row = await tx.one<{ id: string }>(
        `SELECT id FROM items
         WHERE lower(btrim(code)) = lower($1) AND deleted_at IS NULL AND id <> $2
         ORDER BY id LIMIT 1`,
        [code.trim(), id],
      );
      return row?.id;
    }
    case 'category': {
      const name = payload['name'];
      if (typeof name !== 'string' || name.trim() === '') return undefined;
      const row = await tx.one<{ id: string }>(
        `SELECT id FROM categories
         WHERE parent_id IS NOT DISTINCT FROM $1::uuid AND lower(btrim(name)) = lower($2)
           AND deleted_at IS NULL AND id <> $3
         ORDER BY id LIMIT 1`,
        [(payload['parentId']) ?? null, name.trim(), id],
      );
      return row?.id;
    }
  }
}

export async function recordAlias(
  tx: Tx,
  entity: MergeEntity,
  aliasId: string,
  canonicalId: string,
  deviceId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO id_aliases (tenant_id, entity, alias_id, canonical_id, device_id)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, alias_id) DO NOTHING`,
    [entity, aliasId, canonicalId, deviceId],
  );
}

/** Whether this business has merged anything yet; lets a push skip the lookup until it has. */
export async function tenantHasAliases(tx: Tx): Promise<boolean> {
  return (await tx.one('SELECT 1 FROM id_aliases LIMIT 1')) !== undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectUuids(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (UUID.test(value)) into.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) collectUuids(v, into);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectUuids(v, into);
  }
}

function replaceUuids<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    return (UUID.test(value) ? (map.get(value.toLowerCase()) ?? value) : value) as T;
  }
  if (Array.isArray(value)) return (value as unknown[]).map((v) => replaceUuids(v, map)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Json).map(([k, v]) => [k, replaceUuids(v, map)]),
    ) as T;
  }
  return value;
}

/**
 * The payload with every alias id in it replaced by the record it was merged into. An id is a
 * client-made UUID, never reused for another kind of record, so replacing an exact match anywhere
 * in the payload is safe — and covers every place an id can appear, including ones added later.
 */
export async function resolveAliases<T>(tx: Tx, payload: T): Promise<T> {
  const ids = new Set<string>();
  collectUuids(payload, ids);
  if (ids.size === 0) return payload;
  const rows = await tx.many<{ alias_id: string; canonical_id: string }>(
    'SELECT alias_id, canonical_id FROM id_aliases WHERE alias_id = ANY($1::uuid[])',
    [[...ids]],
  );
  if (rows.length === 0) return payload;
  return replaceUuids(payload, new Map(rows.map((r) => [r.alias_id.toLowerCase(), r.canonical_id])));
}

// --- Field-level merge of updates ---------------------------------------------------------------

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** JSON-equal, with null and undefined alike. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface FieldMerge {
  /** The patch to apply: the phone's, with notes joined where both sides changed them. */
  patch: Json;
  /** Fields someone else changed since this phone last saw the record, and this edit overwrites. */
  conflicts: { field: string; from: unknown; to: unknown }[];
}

/**
 * Compares each patched field with what the phone last saw (`was`) and what is there now.
 * Nothing is written here; the caller applies `patch`, then records the conflicts.
 */
export async function mergeUpdate(
  tx: Tx,
  table: string,
  id: string,
  patch: Json,
  was: Json,
): Promise<FieldMerge> {
  const current = await tx.one<{ row: Json }>(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE id = $1`, [
    id,
  ]);
  const merged: Json = { ...patch };
  const conflicts: FieldMerge['conflicts'] = [];
  // Unknown record: nothing to merge against, and the service answers with the not-found error.
  if (!current) return { patch: merged, conflicts };

  for (const [field, to] of Object.entries(patch)) {
    const column = snake(field);
    // Not a column of its own (barcodes replace a whole set): applied as sent.
    if (!(column in current.row) || !(field in was)) continue;
    const now = current.row[column];
    if (same(now, was[field])) continue; // nobody else changed it
    if (same(now, to)) continue; // someone already made the very same change
    if (field === 'notes' && typeof now === 'string' && now.trim() !== '' && typeof to === 'string') {
      // Both sides wrote notes: keep both rather than choosing one.
      merged[field] = now.includes(to) ? now : `${now}\n${to}`;
    }
    conflicts.push({ field, from: now, to: merged[field] });
  }
  return { patch: merged, conflicts };
}

/** Writes the overwritten values to the audit log, once the update has been applied. */
export async function recordConflicts(
  tx: Tx,
  entityType: string,
  entityId: string,
  conflicts: FieldMerge['conflicts'],
): Promise<void> {
  if (conflicts.length === 0) return;
  const changes: FieldChanges = Object.fromEntries(
    conflicts.map((c) => [c.field, { from: c.from, to: c.to }]),
  );
  await recordAudit(tx, {
    action: 'sync.field_conflict',
    entityType,
    entityId,
    changes,
    metadata: { resolution: 'latest write kept' },
  });
}
