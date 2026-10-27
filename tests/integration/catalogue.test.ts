/**
 * Catalogue items: the one thing worth proving end to end here is a field
 * that round-trips through create, read and update exactly as sent — the
 * kind of thing a typo in a column name or an update-map entry breaks
 * silently (the write succeeds, the read just never shows it again).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient, truncateAll } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

interface Item {
  id: string;
  discountPercent: number | null;
}

describe('catalogue items', () => {
  let t: TenantFixture;

  beforeAll(async () => {
    await truncateAll();
    t = await createTenant({ name: 'Catalogue Shop' });
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('a default discount on sale price round-trips through create and update', async () => {
    const id = randomUUID();
    const created = data<Item>(
      await t
        .post('/v1/items')
        .send({
          id,
          itemType: 'service',
          name: 'Consulting',
          unit: 'service',
          salePrice: 50_000,
          taxRatePercent: 18,
          discountPercent: 10,
        })
        .expect(201),
    );
    expect(created.discountPercent).toBe(10);

    const read = data<Item>(await t.get(`/v1/items/${id}`).expect(200));
    expect(read.discountPercent).toBe(10);

    const updated = data<Item>(
      await t.patch(`/v1/items/${id}`).send({ discountPercent: 15 }).expect(200),
    );
    expect(updated.discountPercent).toBe(15);

    const cleared = data<Item>(
      await t.patch(`/v1/items/${id}`).send({ discountPercent: null }).expect(200),
    );
    expect(cleared.discountPercent).toBeNull();
  });

  it('refuses a discount outside 0–100', async () => {
    await t
      .post('/v1/items')
      .send({
        id: randomUUID(),
        itemType: 'goods',
        name: 'Bad Discount Item',
        unit: 'pc',
        salePrice: 10_000,
        taxRatePercent: 18,
        discountPercent: 150,
      })
      .expect(400);
  });
});
