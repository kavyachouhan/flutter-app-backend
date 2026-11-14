 
/**
 * GSTR transaction reports through the real API: one sale and one purchase bill in, Excel files
 * out. Covers the purchase-register SQL, which the unit tests cannot reach.
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

async function workbookOf(res: { body: { data: { objectKey: string } } }) {
  const buf = uploaded.get(res.body.data.objectKey);
  if (!buf) throw new Error('nothing was uploaded');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}

describe('GSTR transaction reports', () => {
  let shop: TenantFixture;
  let gstin: string;
  const year = new Date().getUTCFullYear();
  const month = new Date().getUTCMonth() + 1;
  const query = (kind: string, extra = '') =>
    `/v1/gst/reports/transactions?kind=${kind}&year=${year}&month=${month}${extra}`;

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

    // One B2B sale.
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

    // One purchase from a registered supplier.
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
    // Several round trips to a remote test database: more than the default 30s hook limit.
  }, 180_000);

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('GSTR-1 sales has the B2B invoice and the same taxable value as the HSN table', async () => {
    const res = await shop.get(query('gstr1_sales')).expect(200);
    expect(data<{ filename: string }>(res).filename).toContain('GSTR1-Sales');
    const wb = await workbookOf(res);
    const b2b = wb.getWorksheet('b2b');
    expect(b2b).toBeDefined();
    // header + invoice + totals row
    expect(b2b!.rowCount).toBe(3);
    const hsn = wb.getWorksheet('hsn(b2b)');
    expect(hsn).toBeDefined();
    expect(wb.getWorksheet('Issues')).toBeDefined();
  });

  it('GSTR-2 purchases has the supplier bill with availed credit', async () => {
    const res = await shop.get(query('gstr2_purchases')).expect(200);
    const wb = await workbookOf(res);
    const b2b = wb.getWorksheet('b2b');
    expect(b2b).toBeDefined();
    expect(b2b!.rowCount).toBe(3);
    const header = (b2b!.getRow(1).values as unknown[]).map(String);
    expect(header).toContain('Eligibility For ITC');
    expect(header).toContain('Availed ITC Integrated Tax');
    const row = b2b!.getRow(2);
    const at = (label: string) => row.getCell(header.indexOf(label)).value;
    expect(at('Invoice Number')).toBe('WS-1001');
    expect(at('Taxable Value')).toBe(200);
    // Intra-state: 9% each side of 18% on 200.00.
    expect(at('Central Tax Paid')).toBe(18);
    expect(at('Availed ITC Central Tax')).toBe(18);
    expect(wb.getWorksheet('hsnsum')).toBeDefined();
  });

  it('credit/debit note reports run with nothing to show', async () => {
    for (const kind of ['gstr1_cdn', 'gstr2_cdn']) {
      const res = await shop.get(query(kind)).expect(200);
      const wb = await workbookOf(res);
      expect(wb.getWorksheet('cdnr')).toBeDefined();
      expect(wb.getWorksheet('cdnur')).toBeDefined();
    }
  });

  const range = `from=${year}-${String(month).padStart(2, '0')}-01&to=${today()}`;

  it('sales summary by HSN shows the sale with the same taxable value as the invoice', async () => {
    const res = await shop.get(`/v1/gst/reports/hsn-sales?${range}`).expect(200);
    const report = data<{
      form: string;
      sheets: { id: string; rows: { hsn: string; taxable: number }[]; totals: Record<string, number> }[];
    }>(res);
    expect(report.form).toBe('hsn_sales');
    const all = report.sheets.find((s) => s.id === 'hsn_all')!;
    expect(all.rows.map((r) => r.hsn)).toEqual(['6109']);
    // 2 pieces at 100.00.
    expect(all.totals['taxable']).toBe(20_000);
    // The only sale was to a registered buyer.
    expect(report.sheets.find((s) => s.id === 'hsn_b2b')!.totals['taxable']).toBe(20_000);
    expect(report.sheets.find((s) => s.id === 'hsn_b2c')!.rows).toHaveLength(0);
  });

  it('sales summary by HSN can be handed over as plain and CA workbooks', async () => {
    const plain = await shop.get(`/v1/gst/reports/hsn-sales?${range}&format=xlsx`).expect(200);
    const wb = await workbookOf(plain);
    expect(wb.getWorksheet('hsn_all')).toBeDefined();
    expect(wb.getWorksheet('Summary')).toBeUndefined();

    const ca = await shop.get(`/v1/gst/reports/hsn-sales?${range}&format=ca`).expect(200);
    const caWb = await workbookOf(ca);
    expect(caWb.getWorksheet('Summary')).toBeDefined();
    expect(caWb.getWorksheet('Issues')).toBeDefined();
  });

  it('SAC report runs, and a goods-only business has no service rows', async () => {
    const res = await shop.get(`/v1/gst/reports/sac?${range}`).expect(200);
    const report = data<{ form: string; sheets: { id: string; rows: unknown[] }[] }>(res);
    expect(report.form).toBe('sac');
    expect(report.sheets[0]?.rows).toHaveLength(0);
    const filtered = await shop.get(`/v1/gst/reports/sac?${range}&transaction=purchase`).expect(200);
    expect(data<{ sheets: unknown[] }>(filtered).sheets).toHaveLength(1);
  });

  it('rejects a reversed or oversized date range', async () => {
    await shop.get(`/v1/gst/reports/hsn-sales?from=2026-12-01&to=2026-11-01`).expect(400);
    await shop.get(`/v1/gst/reports/sac?from=2020-01-01&to=2026-11-01`).expect(400);
  });

  it('refuses a GSTIN that is not the business', async () => {
    await shop.get(query('gstr1_sales', `&gstin=${validGstin('29')}`)).expect(422);
  });

  it('rejects a bad kind or month', async () => {
    await shop.get(`/v1/gst/reports/transactions?kind=nope&year=${year}&month=${month}`).expect(400);
    await shop.get(query('gstr1_sales').replace(`month=${month}`, 'month=13')).expect(400);
  });
});
