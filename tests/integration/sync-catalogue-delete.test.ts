/**
 * Item, category and customer deletes made on a device while offline and pushed later.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem } from './setup/fixtures.js';
import { addMember } from './setup/orders.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface OpResult {
  status: 'applied' | 'replayed' | 'rejected';
  error?: { code: string; message: string };
}

async function push(who: TenantFixture, type: string, payload: unknown): Promise<OpResult> {
  const res = await who
    .post('/v1/sync/push')
    .send({ operations: [{ opId: randomUUID(), type, payload }] })
    .expect(200);
  return data<{ results: OpResult[] }>(res).results[0]!;
}

describe('offline deletes through sync', () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant({ name: 'Offline Delete Shop' });
  });
  afterAll(async () => {
    await closePool();
    await closeOwnerClient();
  });

  it('deletes an item, and a retried delete is not an error', async () => {
    const item = await createItem(t);
    expect((await push(t, 'item.delete', { id: item.id })).status).toBe('applied');
    expect((await push(t, 'item.delete', { id: item.id })).status).toBe('applied');
    await t.get(`/v1/items/${item.id}`).expect(404);
  });

  it('deletes an empty category but refuses one that still holds an item', async () => {
    const empty = randomUUID();
    const used = randomUUID();
    expect((await push(t, 'category.create', { id: empty, name: 'Empty' })).status).toBe('applied');
    expect((await push(t, 'category.create', { id: used, name: 'Used' })).status).toBe('applied');
    await t
      .post('/v1/items')
      .send({
        id: randomUUID(),
        categoryId: used,
        itemType: 'goods',
        name: 'In category',
        taxRatePercent: 0,
        unit: 'pcs',
        salePrice: 100,
        trackStock: false,
        pricesIncludeTax: false,
      })
      .expect(201);

    expect((await push(t, 'category.delete', { id: empty })).status).toBe('applied');
    const refused = await push(t, 'category.delete', { id: used });
    expect(refused.status).toBe('rejected');
  });

  it('deletes a settled customer but refuses one who owes', async () => {
    const settled = randomUUID();
    const owing = randomUUID();
    await push(t, 'customer.create', { id: settled, name: 'Settled' });
    await push(t, 'customer.create', { id: owing, name: 'Owing', openingBalance: 5000 });

    expect((await push(t, 'customer.delete', { id: settled })).status).toBe('applied');
    expect((await push(t, 'customer.delete', { id: settled })).status).toBe('applied');
    expect((await push(t, 'customer.delete', { id: owing })).status).toBe('rejected');
  });

  it('rejects an item delete from a cashier, who may not write the catalogue', async () => {
    const item = await createItem(t);
    const cashier = await addMember(t, 'cashier');
    const res = await push(cashier, 'item.delete', { id: item.id });
    expect(res.status).toBe('rejected');
    expect(res.error?.code).toBe('INSUFFICIENT_ROLE');
    await t.get(`/v1/items/${item.id}`).expect(200);
  });

  it('creates, renames and deletes an expense category; a retried create is replayed', async () => {
    const id = randomUUID();
    expect((await push(t, 'expense_category.create', { id, name: 'Rent' })).status).toBe('applied');
    expect((await push(t, 'expense_category.create', { id, name: 'Rent' })).status).toBe('replayed');
    expect(
      (await push(t, 'expense_category.update', { id, patch: { name: 'Shop rent' } })).status,
    ).toBe('applied');
    expect((await push(t, 'expense_category.delete', { id })).status).toBe('applied');
    expect((await push(t, 'expense_category.delete', { id })).status).toBe('applied');
  });

  it('editing an item leaves its unchanged barcodes alone (no delete + new row for devices)', async () => {
    const item = await createItem(t, { barcodes: ['8901000000011', '8901000000028'] });
    const pullBarcodes = async (since: number) =>
      data<{ changes: { entity: string; op: string; row: Record<string, unknown> }[] }>(
        await t.get(`/v1/sync/changes?since=${since}&limit=500`).expect(200),
      ).changes.filter((c) => c.entity === 'item_barcodes');

    const before = await pullBarcodes(0);
    const live = before.filter((c) => c.row['itemId'] === item.id && c.op === 'upsert');
    expect(live).toHaveLength(2);

    const full = data<{ nextSince: number }>(
      await t.get('/v1/sync/changes?since=0&limit=500').expect(200),
    ).nextSince;
    await t
      .patch(`/v1/items/${item.id}`)
      .send({ name: 'Renamed', barcodes: ['8901000000011', '8901000000028'] })
      .expect(200);
    expect(await pullBarcodes(full)).toHaveLength(0);

    await t
      .patch(`/v1/items/${item.id}`)
      .send({ barcodes: ['8901000000011', '8901000000035'] })
      .expect(200);
    const changed = await pullBarcodes(full);
    expect(changed.map((c) => [c.op, c.row['barcode']]).sort()).toEqual(
      [
        ['delete', '8901000000028'],
        ['upsert', '8901000000035'],
      ].sort(),
    );
  });
});
