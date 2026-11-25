/**
 * Composition returns through the real API: CMP-08 for the quarter (rate on turnover, split
 * CGST/SGST) and GSTR-4 for the year; a composition dealer cannot open a GSTR-1 and a regular one
 * cannot open a CMP-08; neither has a JSON export.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createSeries, invoicePayload, leaseBlock, today } from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

vi.mock('../../src/lib/storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/storage.js')>()),
  upload: () => Promise.resolve('test/composition'),
  signDownload: (key: string) =>
    Promise.resolve({ url: `https://files.test/${key}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
}));

interface Period {
  id: string;
  periodMonth: number;
  workings: { sheets: { id: string; rows: Record<string, unknown>[] }[] } | null;
}

describe('composition returns', () => {
  let shop: TenantFixture;
  let gstin: string;
  const year = Number(today().slice(0, 4));
  const month = Number(today().slice(5, 7));
  const fyStart = month >= 4 ? year : year - 1;

  beforeAll(async () => {
    shop = await createTenant({ stateCode: '27' });
    await shop
      .patch('/v1/tenant')
      .send({ isComposition: true, compositionCategory: 'trader', compositionRatePercent: 1 })
      .expect(200);
    const regs = await shop.get('/v1/gst/registrations').expect(200);
    gstin = data<{ gstin: string }[]>(regs)[0]!.gstin;
    const itemId = randomUUID();
    await shop
      .post('/v1/items')
      .send({ id: itemId, itemType: 'goods', name: 'Rice bag', hsnCode: '1006', taxRatePercent: 5, unit: 'pcs', salePrice: 100_000, trackStock: false, pricesIncludeTax: true })
      .expect(201);
    const series = await createSeries(shop, { documentType: 'invoice', prefix: 'BOS' });
    await leaseBlock(shop, series.id, 10);
    const payload = invoicePayload(shop, {
      seriesId: series.id,
      sequenceNo: 1,
      lines: [{ itemId, quantity: 1000, unitPrice: 100_000, taxRatePercent: 0 }],
    });
    const res = await shop
      .post('/v1/invoices')
      .send({ ...payload, payments: [{ id: randomUUID(), mode: 'cash', amount: 100_000 }] });
    if (res.status !== 201) throw new Error(`invoice ${res.status}: ${JSON.stringify(res.body)}`);
  }, 240_000);

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('works out CMP-08 at the composition rate on turnover', async () => {
    const id = randomUUID();
    const created = await shop
      .post('/v1/gst/periods')
      .send({ id, gstin, returnType: 'cmp08', periodYear: year, periodMonth: month })
      .expect(201);
    expect([3, 6, 9, 12]).toContain(data<Period>(created).periodMonth);
    const p = data<Period>(await shop.post(`/v1/gst/periods/${id}/prepare`).expect(200));
    const t3 = p.workings!.sheets.find((s) => s.id === 'cmp08_t3')!;
    const goods = t3.rows.find((r) => r['ref'] === '1')!;
    expect(goods['value']).toBe(100_000);
    // 1% on ₹1,000: ₹5 central + ₹5 State.
    expect(goods['cgst']).toBe(500);
    expect(goods['sgst']).toBe(500);
    await shop.get(`/v1/gst/periods/${id}/export?format=json`).expect(422);
    await shop.get(`/v1/gst/periods/${id}/export?format=xlsx`).expect(200);
  }, 180_000);

  it('works out GSTR-4 for the year from the quarters', async () => {
    const id = randomUUID();
    await shop.post('/v1/gst/periods').send({ id, gstin, returnType: 'gstr4', periodYear: fyStart, periodMonth: 3 }).expect(201);
    const p = data<Period>(await shop.post(`/v1/gst/periods/${id}/prepare`).expect(200));
    expect(p.workings!.sheets.map((s) => s.id)).toEqual(['gstr4_t4', 'gstr4_t5', 'gstr4_t6']);
    expect(p.workings!.sheets.find((s) => s.id === 'gstr4_t5')!.rows).toHaveLength(4);
  }, 240_000);

  it('refuses regular returns for a composition dealer', async () => {
    await shop
      .post('/v1/gst/periods')
      .send({ id: randomUUID(), gstin, returnType: 'gstr1', periodYear: year, periodMonth: month })
      .expect(422);
  });
});
