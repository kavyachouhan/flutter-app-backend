/**
 * Advances through the real API: a receipt voucher for services carries tax (Rule 50), shows in
 * GSTR-1 table 11A and in 3.1(a), and its number in table 13; adjusted against an invoice it
 * leaves 11A; refund and void rules.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createSeries, invoicePayload, leaseBlock, today } from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';

function validGstin(state: string): string {
  const letters = randomUUID()
    .replace(/[^a-f]/g, '')
    .toUpperCase()
    .padEnd(5, 'A')
    .slice(0, 5);
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  const first14 = `${state}${letters}${digits}B1Z`;
  return first14 + gstinCheckCharacter(first14);
}

interface Voucher {
  id: string;
  documentNumber: string;
  taxableAmount: number;
  cgst: number;
  unadjusted: number;
}
interface Period {
  id: string;
  workings: {
    sheets: { id: string; rows: Record<string, unknown>[] }[];
    model: Record<string, unknown>;
  } | null;
}

describe('advances', () => {
  let shop: TenantFixture;
  let gstin: string;
  let customerId: string;
  let voucher: Voucher;
  const year = Number(today().slice(0, 4));
  const month = Number(today().slice(5, 7));

  beforeAll(async () => {
    gstin = validGstin('27');
    shop = await createTenant({ stateCode: '27', gstin });
    customerId = randomUUID();
    await shop
      .post('/v1/customers')
      .send({ id: customerId, name: 'Event Client', addressLine1: '2 Hill Rd', stateCode: '27' })
      .expect(201);
  }, 240_000);

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('issues a services voucher with tax backed out of the advance', async () => {
    const res = await shop
      .post('/v1/gst/advances/receipt-vouchers')
      .send({
        id: randomUUID(),
        outletId: shop.outletId,
        customerId,
        supplyKind: 'services',
        ratePercent: 18,
        amount: 11_800,
      })
      .expect(201);
    voucher = data<Voucher>(res);
    expect(voucher.documentNumber).toMatch(/^RV\/\d{4}\/1$/);
    expect(Number(voucher.taxableAmount)).toBe(10_000);
    expect(Number(voucher.cgst)).toBe(900);
  });

  it('reports it in GSTR-1 table 11A and table 13, and in GSTR-3B 3.1(a)', async () => {
    const g1 = randomUUID();
    await shop
      .post('/v1/gst/periods')
      .send({ id: g1, gstin, returnType: 'gstr1', periodYear: year, periodMonth: month })
      .expect(201);
    const p1 = data<Period>(await shop.post(`/v1/gst/periods/${g1}/prepare`).expect(200));
    const at = p1.workings!.sheets.find((s) => s.id === 'at');
    expect(at?.rows[0]).toMatchObject({ pos: '27', rate: 18, taxable: 10_000 });
    expect(p1.workings!.model['otherSections']).toMatchObject({ at: 1 });
    const docs = p1.workings!.model['documentsIssued'] as { code: string }[];
    expect(docs.map((d) => d.code)).toContain('6');

    const g3 = randomUUID();
    await shop
      .post('/v1/gst/periods')
      .send({ id: g3, gstin, returnType: 'gstr3b', periodYear: year, periodMonth: month })
      .expect(201);
    const p3 = data<Period>(await shop.post(`/v1/gst/periods/${g3}/prepare`).expect(200));
    const outward = p3.workings!.model['outward'] as { taxable: { cgst: number } };
    expect(outward.taxable.cgst).toBe(900);
  }, 180_000);

  it('adjusts the advance against an invoice and refuses more than is left', async () => {
    const itemId = randomUUID();
    await shop
      .post('/v1/items')
      .send({
        id: itemId,
        itemType: 'service',
        name: 'Event setup',
        hsnCode: '998596',
        taxRatePercent: 18,
        unit: 'nos',
        salePrice: 10_000,
        trackStock: false,
        pricesIncludeTax: false,
      })
      .expect(201);
    const series = await createSeries(shop, { documentType: 'invoice', prefix: 'INV' });
    await leaseBlock(shop, series.id, 10);
    const inv = await shop
      .post('/v1/invoices')
      .send(
        invoicePayload(shop, {
          seriesId: series.id,
          sequenceNo: 1,
          customerId,
          lines: [{ itemId, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
        }),
      )
      .expect(201);
    const invoiceId = data<{ id: string }>(inv).id;
    const res = await shop
      .post(`/v1/gst/advances/receipt-vouchers/${voucher.id}/adjust`)
      .send({ invoiceId, amount: 11_800 })
      .expect(201);
    expect(Number(data<Voucher>(res).unadjusted)).toBe(0);
    await shop
      .post(`/v1/gst/advances/receipt-vouchers/${voucher.id}/refund`)
      .send({ id: randomUUID(), amount: 1 })
      .expect(422);
    await shop.post(`/v1/gst/advances/receipt-vouchers/${voucher.id}/void`).expect(422);
  }, 180_000);
});
