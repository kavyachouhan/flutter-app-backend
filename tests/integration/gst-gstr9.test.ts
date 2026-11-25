/* eslint-disable @typescript-eslint/no-explicit-any -- the workbook and JSON are walked untyped */
/**
 * GSTR-9 through the real API: a sale and a purchase in, a prepared annual return out, exported as
 * Excel, CA package and (draft) portal JSON, then recorded as filed. Covers the loader SQL and the
 * new return type, which the unit tests cannot reach.
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createSeries, fyStartYear, invoicePayload, leaseBlock, today } from './setup/fixtures.js';
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

const uploaded = new Map<string, Buffer>();
vi.mock('../../src/lib/storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/storage.js')>()),
  upload: (_kind: string, _type: string, body: Buffer) => {
    const key = `test/${uploaded.size}`;
    uploaded.set(key, body);
    return Promise.resolve(key);
  },
  signDownload: (key: string) =>
    Promise.resolve({
      url: `https://files.test/${key}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
}));

interface Sheet {
  id: string;
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
}
interface Period {
  id: string;
  status: string;
  periodYear: number;
  periodMonth: number;
  periodFrom: string;
  periodTo: string;
  totalTaxable: number | null;
  workings: {
    form: string;
    sheets: Sheet[];
    issues: { code: string; severity: string }[];
    options?: { considerNonTaxAsExempt: boolean };
    model: Record<string, any>;
  } | null;
}

describe('GSTR-9', () => {
  let shop: TenantFixture;
  let gstin: string;
  let periodId: string;
  const startYear = fyStartYear();

  beforeAll(async () => {
    gstin = validGstin('27');
    shop = await createTenant({ stateCode: '27', gstin });
    const itemId = randomUUID();
    await shop
      .post('/v1/items')
      .send({
        id: itemId,
        itemType: 'goods',
        name: 'Cotton shirt',
        hsnCode: '6109',
        taxRatePercent: 18,
        unit: 'pcs',
        salePrice: 10_000,
        trackStock: false,
        pricesIncludeTax: false,
      })
      .expect(201);

    const series = await createSeries(shop, { documentType: 'invoice', prefix: 'INV' });
    await leaseBlock(shop, series.id, 100);
    const buyer = randomUUID();
    await shop
      .post('/v1/customers')
      .send({
        id: buyer,
        name: 'Registered Buyer',
        addressLine1: '9 Station Road',
        stateCode: '27',
        gstin: validGstin('27'),
      })
      .expect(201);
    const sale = await shop.post('/v1/invoices').send(
      invoicePayload(shop, {
        seriesId: series.id,
        sequenceNo: 1,
        customerId: buyer,
        lines: [{ itemId, quantity: 2000, unitPrice: 10_000, taxRatePercent: 18 }],
      }),
    );
    expect(sale.status).toBe(201);

    const supplierId = randomUUID();
    await shop
      .post('/v1/suppliers')
      .send({ id: supplierId, name: 'Wholesale Co', stateCode: '27', gstin: validGstin('27') })
      .expect(201);
    await shop
      .post('/v1/purchase-bills')
      .send({
        id: randomUUID(),
        outletId: shop.outletId,
        supplierId,
        documentDate: today(),
        supplierInvoiceNo: 'WS-1001',
        supplierInvoiceDate: today(),
        receivedAt: new Date().toISOString(),
        lines: [{ id: randomUUID(), itemId, quantity: 4000, unitPrice: 5000, taxRatePercent: 18 }],
      })
      .expect(201);
  }, 240_000);

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  const workbook = async (key: string) => {
    const buf = uploaded.get(key);
    if (!buf) throw new Error('nothing was uploaded');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    return wb;
  };

  it('opens a financial-year period whatever month the client names', async () => {
    const res = await shop
      .post('/v1/gst/periods')
      .send({ id: randomUUID(), gstin, returnType: 'gstr9', periodYear: startYear, periodMonth: 7 })
      .expect(201);
    const p = data<Period>(res);
    periodId = p.id;
    expect(p.periodFrom).toBe(`${startYear}-04-01`);
    expect(p.periodTo).toBe(`${startYear + 1}-03-31`);
    // The key is normalised to the year's last month, so a second request finds the same period.
    expect(p.periodMonth).toBe(3);
    const again = await shop
      .post('/v1/gst/periods')
      .send({ id: randomUUID(), gstin, returnType: 'gstr9', periodYear: startYear, periodMonth: 2 })
      .expect(201);
    expect(data<Period>(again).id).toBe(periodId);
  });

  it('prepares from the books, saying which periods were not prepared', async () => {
    const res = await shop.post(`/v1/gst/periods/${periodId}/prepare`).send({}).expect(200);
    const p = data<Period>(res);
    expect(p.status).toBe('prepared');
    expect(p.workings?.form).toBe('gstr9');
    const ids = p.workings!.sheets.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(['pt2_outward', 'pt3_itc', 'pt3_rev', 'pt3_other', 'pt4_tax', 'hsn_out', 'hsn_in', 'recon', 'coverage']),
    );
    const part2 = p.workings!.sheets.find((s) => s.id === 'pt2_outward')!;
    const row = (ref: string) => part2.rows.find((r) => r['ref'] === ref)!;
    // One sale to a registered buyer: 2 pieces at 100.00.
    expect(row('4B')['taxable']).toBe(20_000);
    expect(row('4N')['taxable']).toBe(20_000);
    // No return was prepared for the year, so every period was worked out from the books.
    const codes = p.workings!.issues.map((i) => i.code);
    expect(codes).toContain('period_not_prepared');
    expect(codes).toContain('ledger_not_imported');
    // The books and the live periods agree, so there is no reconciliation warning.
    expect(codes).not.toContain('returns_differ_from_books');
    expect(codes).not.toContain('gstr1_gstr3b_differ');
    expect(p.totalTaxable).toBe(20_000);
  }, 120_000);

  it('takes credit from the register and tax payable from the returns', async () => {
    const res = await shop.get(`/v1/gst/periods/${periodId}`).expect(200);
    const w = data<Period>(res).workings!;
    const itc = w.sheets.find((s) => s.id === 'pt3_itc')!;
    const sixB = itc.rows.find((r) => r['ref'] === '6B')!;
    // 4 pieces at 50.00 = 200.00 taxable (quantity is in thousandths); 9% each side = 18.00.
    expect(sixB['cgst']).toBe(1_800);
    expect(sixB['sgst']).toBe(1_800);
    const six_a = itc.rows.find((r) => r['ref'] === '6A')!;
    expect(six_a['cgst']).toBe(1_800);
    const tax = w.sheets.find((s) => s.id === 'pt4_tax')!;
    expect(tax.rows.find((r) => r['ref'] === '9B')!['payable']).toBe(1_800);
    expect(tax.rows.find((r) => r['ref'] === '9B')!['paid']).toBeNull();
    const hsn = w.sheets.find((s) => s.id === 'hsn_out')!;
    expect(hsn.rows.map((r) => r['hsn'])).toEqual(['6109']);
    expect(w.sheets.find((s) => s.id === 'hsn_in')!.rows.map((r) => r['hsn'])).toEqual(['6109']);
  });

  it('re-prepares with the option and remembers it', async () => {
    const res = await shop
      .post(`/v1/gst/periods/${periodId}/prepare`)
      .send({ considerNonTaxAsExempt: true })
      .expect(200);
    expect(data<Period>(res).workings?.options?.considerNonTaxAsExempt).toBe(true);
    const again = await shop.post(`/v1/gst/periods/${periodId}/prepare`).send({}).expect(200);
    expect(data<Period>(again).workings?.options?.considerNonTaxAsExempt).toBe(true);
  }, 180_000);

  it('exports the workbook and the CA package from the stored workings', async () => {
    const plain = await shop.get(`/v1/gst/periods/${periodId}/export?format=xlsx`).expect(200);
    const wb = await workbook(data<{ objectKey: string }>(plain).objectKey);
    expect(wb.getWorksheet('pt2_outward')).toBeDefined();
    expect(wb.getWorksheet('Summary')).toBeUndefined();

    const ca = await shop.get(`/v1/gst/periods/${periodId}/export?format=ca`).expect(200);
    const caWb = await workbook(data<{ objectKey: string }>(ca).objectKey);
    expect(caWb.getWorksheet('Summary')).toBeDefined();
    expect(caWb.getWorksheet('Issues')).toBeDefined();
    expect(caWb.getWorksheet('coverage')).toBeDefined();
  });

  it('exports portal JSON as a draft that validates against the official schema', async () => {
    const res = await shop.get(`/v1/gst/periods/${periodId}/export?format=json`).expect(200);
    const out = data<{ objectKey: string; filename: string; payloadStatus: string; mapperId: string }>(res);
    expect(out.payloadStatus).toBe('draft');
    expect(out.filename).toMatch(/-DRAFT\.json$/);
    expect(out.mapperId).toBe('gstr9-v2026.11');
    const payload = JSON.parse(uploaded.get(out.objectKey)!.toString('utf8')) as {
      gstin: string;
      fp: string;
      table4: { b2b: { txval: number } };
      table8?: unknown;
    };
    expect(payload.gstin).toBe(gstin);
    expect(payload.fp).toBe(`03${startYear + 1}`);
    expect(payload.table4.b2b.txval).toBe(200);
    expect(payload.table8).toBeUndefined();
  });

  it('is filed on request, and then cannot be prepared again', async () => {
    await shop
      .post(`/v1/gst/periods/${periodId}/file`)
      .send({ confirm: true, arn: 'AA2701260000001' })
      .expect(200);
    await shop.post(`/v1/gst/periods/${periodId}/prepare`).send({}).expect(409);
  });
});
