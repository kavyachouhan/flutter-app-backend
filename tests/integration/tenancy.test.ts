/**
 * The isolation guarantee, proved rather than assumed.
 *
 * Every one of these runs through HTTP as the unprivileged app role, so they
 * exercise the real RLS policies rather than the application's own filters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient, truncateAll } from './setup/database.js';
import { createTenant, app, type TenantFixture } from './setup/tenant.js';
import { data, rows } from './setup/body.js';
import request from 'supertest';
import { closePool } from '../../src/db/pool.js';

describe('tenant isolation', () => {
  let a: TenantFixture;
  let b: TenantFixture;
  let itemAId: string;

  beforeAll(async () => {
    await truncateAll();
    a = await createTenant({ name: 'Shop A', stateCode: '27' });
    b = await createTenant({ name: 'Shop B', stateCode: '29', gstin: '29AAAPA1234A1Z5' });

    itemAId = randomUUID();
    await a
      .post('/v1/items')
      .send({
        id: itemAId,
        itemType: 'goods',
        name: 'Shop A Widget',
        taxRatePercent: 18,
        unit: 'pcs',
        salePrice: 10_000,
      })
      .expect(201);
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('onboards a tenant and issues a usable session', async () => {
    const tenant = data<{ id: string; name: string }>(await a.get('/v1/tenant').expect(200));
    expect(tenant.id).toBe(a.tenantId);
    expect(tenant.name).toBe('Shop A');
  });

  it('gives each tenant its own default outlet and counter', () => {
    expect(a.outletId).not.toBe(b.outletId);
    expect(a.tenantId).not.toBe(b.tenantId);
  });

  // The rule from the README: another tenant's row is 404, never 403, because
  // a 403 would confirm the record exists across the boundary.
  it('hides another tenant’s item behind a 404', async () => {
    await a.get(`/v1/items/${itemAId}`).expect(200);
    await b.get(`/v1/items/${itemAId}`).expect(404);
  });

  it('never leaks another tenant’s rows into a list', async () => {
    const items = rows<{ id: string }>(await b.get('/v1/items').expect(200));
    expect(items.map((row) => row.id)).not.toContain(itemAId);
    expect(items).toHaveLength(0);
  });

  it('rejects a request with no token', async () => {
    await request(app).get('/v1/items').expect(401);
  });

  it('rejects a garbage token', async () => {
    await request(app).get('/v1/items').set('Authorization', 'Bearer not-a-real-token').expect(401);
  });

  it('answers liveness without a token or a database', async () => {
    await request(app).get('/healthz').expect(200);
  });
});
