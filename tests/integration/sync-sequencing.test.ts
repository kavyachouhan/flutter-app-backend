/**
 * The load-bearing assumption behind the whole sync protocol.
 *
 * 0001_foundation.sql claims that allocating server_seq under a per-tenant row
 * lock held until commit makes sequence order equal commit order. Every pull
 * design rests on it: a client asks for "changes after N", so if a transaction
 * can take a lower seq and commit later, that row is skipped forever and the
 * device never learns it existed.
 *
 * That claim is only falsifiable with concurrent writers against a real
 * database, which is precisely why it cannot be a unit test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient, ownerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem } from './setup/fixtures.js';
import { closePool } from '../../src/db/pool.js';

describe('server_seq sequencing', () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant({ name: 'Sync Shop' });
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('never reuses a sequence number within a tenant', async () => {
    await Promise.all(Array.from({ length: 8 }, () => createItem(t)));

    const c = await ownerClient();
    const { rows } = await c.query<{ server_seq: string }>(
      'SELECT server_seq FROM items WHERE tenant_id = $1',
      [t.tenantId],
    );
    const seqs = rows.map((r) => Number(r.server_seq));
    expect(seqs.length).toBeGreaterThanOrEqual(8);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('assigns a strictly increasing seq across concurrent writers', async () => {
    const before = await highWaterMark(t.tenantId);
    await Promise.all(Array.from({ length: 10 }, () => createItem(t)));
    const after = await highWaterMark(t.tenantId);
    expect(after).toBeGreaterThan(before);
  });

  /**
   * The real property: no committed row may carry a seq at or below a
   * watermark a client has already consumed. Writes run while a "pull" reads,
   * and anything that lands must land above what the pull observed.
   */
  it('never commits a row beneath an already-published watermark', async () => {
    const watermark = await highWaterMark(t.tenantId);

    // Written concurrently, and read while they are still in flight — the
    // shape of a device pulling changes during a busy till session.
    const writes = Promise.all(Array.from({ length: 12 }, () => createItem(t)));
    for (let i = 0; i < 5; i++) await highWaterMark(t.tenantId);
    const created = await writes;

    const c = await ownerClient();
    const { rows } = await c.query<{ server_seq: string }>(
      'SELECT server_seq FROM items WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
      [t.tenantId, created.map((item) => item.id)],
    );

    // A row committed after the watermark was published must carry a seq at or
    // above it. Anything lower would sit below a cursor a client already has,
    // and that client would never see the row.
    expect(rows).toHaveLength(created.length);
    for (const row of rows) {
      expect(Number(row.server_seq)).toBeGreaterThanOrEqual(watermark);
    }
  });

  it('keeps each tenant on its own counter', async () => {
    const other = await createTenant({ name: 'Other Sync Shop', stateCode: '29' });
    await createItem(other);

    const c = await ownerClient();
    const { rows } = await c.query<{ tenant_id: string; next_seq: string }>(
      'SELECT tenant_id, next_seq FROM app.tenant_sync_counters WHERE tenant_id = ANY($1::uuid[])',
      [[t.tenantId, other.tenantId]],
    );
    expect(rows).toHaveLength(2);
    // A fresh tenant starts low; it does not inherit the busy tenant's counter.
    const otherSeq = rows.find((r) => r.tenant_id === other.tenantId);
    const mineSeq = rows.find((r) => r.tenant_id === t.tenantId);
    expect(Number(otherSeq?.next_seq)).toBeLessThan(Number(mineSeq?.next_seq));
  });
});

async function highWaterMark(tenantId: string): Promise<number> {
  const c = await ownerClient();
  const { rows } = await c.query<{ next_seq: string }>(
    'SELECT next_seq FROM app.tenant_sync_counters WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(rows[0]?.next_seq ?? 0);
}
