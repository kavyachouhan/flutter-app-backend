/**
 * The A0b database foundations, proved through the real schema (freeze §1–§5, §9a): the SQL GSTIN
 * check agrees with the shared vectors, the old tenant/outlet columns drive the registration
 * tables, parties get their treatment, issued documents get a registration and a number-registry
 * row, and the lifecycle CHECKs hold.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient, ownerClient } from './setup/database.js';
import { app, createTenant, type TenantFixture } from './setup/tenant.js';
import { closePool } from '../../src/db/pool.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';

void app;

function validGstin(state: string): string {
  const letters = randomUUID().replace(/[^a-f]/g, '').toUpperCase().padEnd(5, 'A').slice(0, 5);
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  const first14 = `${state}${letters}${digits}B1Z`;
  return first14 + gstinCheckCharacter(first14);
}

describe('GST foundations', () => {
  let shop: TenantFixture;

  beforeAll(async () => {
    shop = await createTenant({ stateCode: '27' });
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('app.gstin_valid agrees with every case in gstin-vectors.json', async () => {
    const path = fileURLToPath(new URL('../../contracts/gstin-vectors.json', import.meta.url));
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      cases: { op: string; name: string; input: { value: string }; expected: { result: string | null } }[];
    };
    const db = await ownerClient();
    const cases = file.cases.filter((c) => c.op === 'gstinProblem');
    expect(cases.length).toBeGreaterThan(100);
    const { rows } = await db.query<{ v: string; ok: boolean }>(
      'SELECT v, app.gstin_valid(v) AS ok FROM unnest($1::text[]) AS v',
      [cases.map((c) => c.input.value)],
    );
    const sql = new Map(rows.map((r) => [r.v, r.ok]));
    for (const c of cases) {
      expect(sql.get(c.input.value), c.name).toBe(c.expected.result === null);
    }
  });

  it('onboarding a registered business creates its registration, profile and outlet link', async () => {
    const db = await ownerClient();
    const reg = await db.query<{ id: string; gstin: string; state_code: string; effective_from: Date }>(
      'SELECT id, gstin, state_code, effective_from FROM gst_registrations WHERE tenant_id = $1',
      [shop.tenantId],
    );
    expect(reg.rows).toHaveLength(1);
    expect(reg.rows[0]!.state_code).toBe('27');

    const profiles = await db.query<{ taxpayer_scheme: string; filing_frequency: string }>(
      'SELECT taxpayer_scheme, filing_frequency FROM gst_registration_profiles WHERE registration_id = $1',
      [reg.rows[0]!.id],
    );
    expect(profiles.rows).toEqual([{ taxpayer_scheme: 'regular', filing_frequency: 'monthly' }]);

    const outlet = await db.query<{ registration_id: string }>('SELECT registration_id FROM outlets WHERE id = $1', [
      shop.outletId,
    ]);
    expect(outlet.rows[0]!.registration_id).toBe(reg.rows[0]!.id);
  });

  it('an unregistered business has no registration', async () => {
    const plain = await createTenant({ isGstRegistered: false });
    const db = await ownerClient();
    const reg = await db.query('SELECT 1 FROM gst_registrations WHERE tenant_id = $1', [plain.tenantId]);
    expect(reg.rows).toHaveLength(0);
    const outlet = await db.query<{ registration_id: string | null }>(
      'SELECT registration_id FROM outlets WHERE id = $1',
      [plain.outletId],
    );
    expect(outlet.rows[0]!.registration_id).toBeNull();
  });

  it('an outlet given its own GSTIN gets its own registration', async () => {
    const multi = await createTenant({ stateCode: '27' });
    await multi
      .patch(`/v1/outlets/${multi.outletId}`)
      .send({ stateCode: '29', gstin: validGstin('29') })
      .expect(200);
    const db = await ownerClient();
    const { rows } = await db.query<{ gstin: string; registration_gstin: string }>(
      `SELECT o.gstin, r.gstin AS registration_gstin FROM outlets o JOIN gst_registrations r ON r.id = o.registration_id
        WHERE o.id = $1`,
      [multi.outletId],
    );
    expect(rows[0]!.registration_gstin).toBe(rows[0]!.gstin);
    const all = await db.query('SELECT 1 FROM gst_registrations WHERE tenant_id = $1', [multi.tenantId]);
    expect(all.rows).toHaveLength(2);
  });

  it('refuses an outlet GSTIN from another state as a validation error', async () => {
    const res = await shop.patch(`/v1/outlets/${shop.outletId}`).send({ stateCode: '27', gstin: validGstin('29') });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a GSTIN with a wrong check character before it reaches the database', async () => {
    const good = validGstin('27');
    const last = good.charAt(14) === 'A' ? 'B' : 'A';
    const res = await shop.post('/v1/customers').send({ id: randomUUID(), name: 'Bad', gstin: good.slice(0, 14) + last });
    expect(res.status).toBe(400);
  });

  it('gives parties a treatment and a state from their GSTIN', async () => {
    const withGstin = randomUUID();
    const walkIn = randomUUID();
    const gstin = validGstin('27');
    await shop.post('/v1/customers').send({ id: withGstin, name: 'Registered', gstin }).expect(201);
    await shop.post('/v1/customers').send({ id: walkIn, name: 'Walk in' }).expect(201);
    const db = await ownerClient();
    const { rows } = await db.query<{ id: string; gst_treatment: string; state_code: string | null }>(
      'SELECT id, gst_treatment, state_code FROM customers WHERE id = ANY($1::uuid[])',
      [[withGstin, walkIn]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(withGstin)).toMatchObject({ gst_treatment: 'registered_regular', state_code: '27' });
    expect(byId.get(walkIn)).toMatchObject({ gst_treatment: 'consumer', state_code: null });
  });

  it('enforces the domestic address rule even when fields are missing', async () => {
    const db = await ownerClient();
    const customer = randomUUID();
    await shop.post('/v1/customers').send({ id: customer, name: 'Ship to' }).expect(201);
    const insert = (over: { state: string | null; postal: string | null; country?: string }) =>
      db.query(
        `INSERT INTO customer_addresses (id, tenant_id, customer_id, line1, city, country_code, state_code, postal_code, is_default)
         VALUES ($1, $2, $3, 'L1', 'City', $4, $5, $6, false)`,
        [randomUUID(), shop.tenantId, customer, over.country ?? 'IN', over.state, over.postal],
      );
    await expect(insert({ state: null, postal: '400001' })).rejects.toThrow(/customer_addresses_domestic/);
    await expect(insert({ state: '27', postal: null })).rejects.toThrow(/customer_addresses_domestic/);
    await expect(insert({ state: '27', postal: '12345' })).rejects.toThrow(/customer_addresses_domestic/);
    await insert({ state: '27', postal: '400001' });
    await insert({ state: null, postal: 'SW1A 1AA', country: 'GB' });
    await expect(insert({ state: '27', postal: 'SW1A', country: 'GB' })).rejects.toThrow(/customer_addresses_overseas/);
  });

  it('rejects overlapping registration profiles but allows adjoining half-open ones', async () => {
    const db = await ownerClient();
    const { rows } = await db.query<{ id: string }>('SELECT id FROM gst_registrations WHERE tenant_id = $1 LIMIT 1', [
      shop.tenantId,
    ]);
    const regId = rows[0]!.id;
    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM gst_registration_profiles WHERE registration_id = $1', [regId]);
      const add = (from: string, to: string | null) =>
        db.query(
          `INSERT INTO gst_registration_profiles (id, tenant_id, registration_id, effective_from, effective_to, taxpayer_scheme, filing_frequency)
           VALUES ($1, $2, $3, $4, $5, 'regular', 'monthly')`,
          [randomUUID(), shop.tenantId, regId, from, to],
        );
      await add('2017-07-01', '2026-04-01');
      await add('2026-04-01', null);
      await db.query('SAVEPOINT s');
      await expect(add('2026-03-31', '2026-04-02')).rejects.toThrow(/exclu|conflict/i);
      await db.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('keeps published and legacy rule sets immutable', async () => {
    const db = await ownerClient();
    const legacy = await db.query<{ status: string }>("SELECT status FROM gst_rule_sets WHERE version = 'legacy'");
    expect(legacy.rows[0]!.status).toBe('legacy');
    await expect(db.query("UPDATE gst_rule_sets SET revision = 2 WHERE version = 'legacy'")).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM gst_rule_sets WHERE version = 'legacy'")).rejects.toThrow(/only drafts/);
  });
});
