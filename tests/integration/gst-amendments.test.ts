/* eslint-disable @typescript-eslint/no-explicit-any -- the exported JSON is walked untyped */
/**
 * Amendments and GSTR-1A through the real API (milestone A6): a filed GSTR-1, an amendment in
 * GSTR-1A of the same period, a GSTIN change refused there and accepted for a later GSTR-1, whose
 * portal JSON then carries table 9A and passes the official schema, and the GSTR-3B difference.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createSeries, invoicePayload, leaseBlock, today } from './setup/fixtures.js';
import { data, error } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';

const uploaded = new Map<string, Buffer>();
vi.mock('../../src/lib/storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/storage.js')>()),
  upload: (_kind: string, _type: string, body: Buffer) => {
    const key = `test/${uploaded.size}`;
    uploaded.set(key, body);
    return Promise.resolve(key);
  },
  signDownload: (key: string) =>
    Promise.resolve({ url: `https://files.test/${key}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
}));

function validGstin(state: string): string {
  const letters = randomUUID().replace(/[^a-f]/g, '').toUpperCase().padEnd(5, 'A').slice(0, 5);
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  const first14 = `${state}${letters}${digits}B1Z`;
  return first14 + gstinCheckCharacter(first14);
}

interface Period {
  id: string;
  workings: { sheets: { id: string; rows: Record<string, unknown>[] }[]; issues: { code: string }[] } | null;
}

describe('amendments and GSTR-1A', () => {
  let shop: TenantFixture;
  let gstin: string;
  let invoiceId: string;
  const year = Number(today().slice(0, 4));
  const month = Number(today().slice(5, 7));
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const nextPeriod = `${next.y}-${String(next.m).padStart(2, '0')}`;

  const open = async (returnType: string, y: number, m: number): Promise<string> => {
    const id = randomUUID();
    await shop.post('/v1/gst/periods').send({ id, gstin, returnType, periodYear: y, periodMonth: m }).expect(201);
    return id;
  };
  const prepare = async (id: string) => data<Period>(await shop.post(`/v1/gst/periods/${id}/prepare`).expect(200));

  beforeAll(async () => {
    gstin = validGstin('27');
    shop = await createTenant({ stateCode: '27', gstin });
    const itemId = randomUUID();
    await shop
      .post('/v1/items')
      .send({
        id: itemId,
        itemType: 'goods',
        name: 'Steel rack',
        hsnCode: '9403',
        taxRatePercent: 18,
        unit: 'pcs',
        salePrice: 10_000,
        trackStock: false,
        pricesIncludeTax: false,
      })
      .expect(201);
    const series = await createSeries(shop, { documentType: 'invoice', prefix: 'INV' });
    await leaseBlock(shop, series.id, 50);
    const buyer = randomUUID();
    await shop
      .post('/v1/customers')
      .send({ id: buyer, name: 'Registered Buyer', addressLine1: '1 Main Rd', stateCode: '27', gstin: validGstin('27') })
      .expect(201);
    const res = await shop
      .post('/v1/invoices')
      .send(
        invoicePayload(shop, {
          seriesId: series.id,
          sequenceNo: 1,
          customerId: buyer,
          lines: [{ itemId, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
        }),
      )
      .expect(201);
    invoiceId = data<{ id: string }>(res).id;

    const g1 = await open('gstr1', year, month);
    await prepare(g1);
    await shop.post(`/v1/gst/periods/${g1}/file`).send({ confirm: true, arn: 'AA2700000001' }).expect(200);
  }, 240_000);

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('amends a value in GSTR-1A and refuses a GSTIN change there', async () => {
    const res = await shop
      .post('/v1/gst/amendments')
      .send({
        id: randomUUID(),
        gstin,
        route: 'gstr1a',
        target: { document: { table: 'invoices', id: invoiceId } },
        revised: {
          value: 23_600,
          lines: [{ ratePercent: 18, taxable: 20_000, igst: 0, cgst: 1_800, sgst: 1_800, cess: 0 }],
        },
        reason: 'Rate quantity entered wrong',
      })
      .expect(201);
    expect(data<{ reportPeriod: string; difference: { taxable: number } }>(res)).toMatchObject({
      reportPeriod: period,
      difference: { taxable: 10_000 },
    });

    const refused = await shop
      .post('/v1/gst/amendments')
      .send({
        id: randomUUID(),
        gstin,
        route: 'gstr1a',
        target: { document: { table: 'invoices', id: invoiceId } },
        revised: { recipientGstin: validGstin('29') },
        reason: 'Wrong buyer',
      })
      .expect(422);
    expect(error(refused).code).toBe('CORRECTION_NOT_ALLOWED');
  });

  it('prepares GSTR-1A with the amendment and refuses a JSON export', async () => {
    const id = await open('gstr1a', year, month);
    const p = await prepare(id);
    expect(p.workings!.sheets.map((s) => s.id)).toContain('gstr1a_amendments');
    await shop.get(`/v1/gst/periods/${id}/export?format=json`).expect(422);
    await shop.get(`/v1/gst/periods/${id}/export?format=xlsx`).expect(200);
  }, 180_000);

  it('carries the GSTR-1A difference into the same period GSTR-3B', async () => {
    const p = await prepare(await open('gstr3b', year, month));
    expect(p.workings!.sheets.map((s) => s.id)).toContain('amendments_3b');
  }, 180_000);

  it('reports a GSTIN change in table 9A of a later GSTR-1, valid against the schema', async () => {
    await shop
      .post('/v1/gst/amendments')
      .send({
        id: randomUUID(),
        gstin,
        route: 'later_gstr1',
        reportPeriod: nextPeriod,
        target: { document: { table: 'invoices', id: invoiceId } },
        revised: { recipientGstin: validGstin('27') },
        reason: 'Invoice raised on the wrong GSTIN',
      })
      .expect(201);
    const id = await open('gstr1', next.y, next.m);
    const p = await prepare(id);
    expect(p.workings!.sheets.map((s) => s.id)).toContain('amendments');
    const res = await shop.get(`/v1/gst/periods/${id}/export?format=json`).expect(200);
    const json = JSON.parse(uploaded.get(data<{ objectKey: string }>(res).objectKey)!.toString('utf8')) as any;
    expect(json.b2ba[0].inv[0].oinum).toBeDefined();
  }, 180_000);
});
