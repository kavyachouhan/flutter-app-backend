/**
 * The ITC engine through the real API (milestone A7): blocked credit and reverse charge in GSTR-3B
 * Table 4, the RCM self-invoice, movements written when the return is filed and not claimed again
 * in the next one, the credit-facts correction, IMS decisions and their export.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient, ownerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { today } from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { gstinCheckCharacter } from '../../src/domain/gst/gstin.js';

function validGstin(state: string): string {
  const letters = randomUUID().replace(/[^a-f]/g, '').toUpperCase().padEnd(5, 'A').slice(0, 5);
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  const first14 = `${state}${letters}${digits}B1Z`;
  return first14 + gstinCheckCharacter(first14);
}

interface Period {
  id: string;
  status: string;
  workings: {
    sheets: { id: string; rows: Record<string, unknown>[] }[];
    issues: { code: string }[];
    model: { itc: { available: Record<string, { cgst: number }>; reversed: Record<string, { cgst: number }> } };
  } | null;
}

describe('ITC engine', () => {
  let shop: TenantFixture;
  let gstin: string;
  let itemId: string;
  let blockedBill: string;
  let rcmBill: string;
  const year = Number(today().slice(0, 4));
  const month = Number(today().slice(5, 7));
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

  const supplier = async (fields: Record<string, unknown>) => {
    const id = randomUUID();
    await shop.post('/v1/suppliers').send({ id, name: 'Supplier', stateCode: '27', ...fields }).expect(201);
    return id;
  };
  const bill = async (supplierId: string, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const res = await shop.post('/v1/purchase-bills').send({
      id,
      outletId: shop.outletId,
      supplierId,
      documentDate: today(),
      supplierInvoiceNo: `S-${id.slice(0, 6)}`,
      supplierInvoiceDate: today(),
      receivedAt: new Date().toISOString(),
      lines: [{ id: randomUUID(), itemId, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
      ...extra,
    });
    if (res.status !== 201) throw new Error(`bill ${res.status}: ${JSON.stringify(res.body)}`);
    return id;
  };
  const prepare = async (y: number, m: number): Promise<Period> => {
    const id = randomUUID();
    await shop
      .post('/v1/gst/periods')
      .send({ id, gstin, returnType: 'gstr3b', periodYear: y, periodMonth: m })
      .expect(201);
    return data<Period>(await shop.post(`/v1/gst/periods/${id}/prepare`).expect(200));
  };

  beforeAll(async () => {
    gstin = validGstin('27');
    shop = await createTenant({ stateCode: '27', gstin });
    itemId = randomUUID();
    await shop
      .post('/v1/items')
      .send({
        id: itemId,
        itemType: 'goods',
        name: 'Office chair',
        hsnCode: '9401',
        taxRatePercent: 18,
        unit: 'pcs',
        salePrice: 10_000,
        trackStock: false,
        pricesIncludeTax: false,
      })
      .expect(201);
    const registered = await supplier({ gstin: validGstin('27') });
    const unregistered = await supplier({});
    // ₹100 at 18% intra-state: 9.00 CGST + 9.00 SGST.
    await bill(registered);
    blockedBill = await bill(registered, { blockedCreditCode: 's17_5_g' });
    rcmBill = await bill(unregistered, { isReverseCharge: true });
  }, 240_000);

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('corrects the credit facts of a bill before filing', async () => {
    const res = await shop
      .patch(`/v1/purchase-bills/${blockedBill}/itc`)
      .send({ blockedCreditCode: 's17_5_b_i' })
      .expect(200);
    expect(data<{ blockedCreditCode: string }>(res).blockedCreditCode).toBe('s17_5_b_i');
  });

  it('issues the RCM self-invoice, once', async () => {
    const res = await shop
      .post('/v1/gst/itc/rcm-self-invoices')
      .send({ id: randomUUID(), purchaseBillId: rcmBill, documentDate: today() })
      .expect(201);
    const si = data<{ documentNumber: string; cgst: number }>(res);
    expect(si.documentNumber).toMatch(/^SI\/\d{4}\/1$/);
    expect(Number(si.cgst)).toBe(900);
    await shop
      .post('/v1/gst/itc/rcm-self-invoices')
      .send({ id: randomUUID(), purchaseBillId: rcmBill })
      .expect(200);
  });

  it('builds Table 4 from the engine: credit, blocked reversal, reverse charge', async () => {
    const p = await prepare(year, month);
    const itc = p.workings!.model.itc;
    // No GSTR-2B imported: credit follows the books, with a warning.
    expect(p.workings!.issues.map((i) => i.code)).toContain('itc_without_2b');
    expect(itc.available['other']!.cgst).toBe(1_800); // both domestic bills
    expect(itc.reversed['rules_38_42_43_17_5']!.cgst).toBe(900); // the blocked one
    expect(itc.available['reverse_charge']!.cgst).toBe(900);
    expect(p.workings!.sheets.map((s) => s.id)).toContain('itc_movements');

    await shop.post(`/v1/gst/periods/${p.id}/file`).send({ confirm: true, arn: 'AA270000000001' }).expect(200);
    const owner = await ownerClient();
    const count = await owner.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM itc_movements WHERE return_period_id = $1',
      [p.id],
    );
    expect(Number(count.rows[0]?.n)).toBeGreaterThanOrEqual(4);
  }, 180_000);

  it('does not claim the same credit again in the next return', async () => {
    const p = await prepare(next.y, next.m);
    expect(p.workings!.model.itc.available['other']!.cgst).toBe(0);
    expect(p.workings!.model.itc.available['reverse_charge']!.cgst).toBe(0);
  }, 180_000);

  it('refuses to correct the credit facts once filed', async () => {
    await shop
      .patch(`/v1/purchase-bills/${blockedBill}/itc`)
      .send({ itcUse: 'common' })
      .expect(422);
  });

  it('records IMS decisions and exports the upload file', async () => {
    await shop
      .post('/v1/gst/itc/ims-actions')
      .send({
        gstin,
        actions: [
          {
            section: 'b2b',
            supplierGstin: validGstin('29'),
            documentNumber: 'X-1',
            documentDate: today(),
            documentValue: 11_800,
            action: 'reject',
            remarks: 'Not our purchase',
          },
        ],
      })
      .expect(201);
    const res = await shop.get(`/v1/gst/itc/ims-actions/export?gstin=${gstin}`).expect(200);
    const out = data<{ payload: { rtin: string; reqtyp: string; invdata: Record<string, { action: string; inum: string }[]> } }>(res);
    expect(out.payload).toMatchObject({ rtin: gstin, reqtyp: 'SAVE' });
    expect(out.payload.invdata['b2b']?.[0]).toMatchObject({ action: 'R', inum: 'X-1' });
  });
});
