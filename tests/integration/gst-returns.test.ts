/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- the exported JSON is walked untyped */
/**
 * GSTR-1 and GSTR-3B through the real API: bills in, prepared tables out, and every export drawn
 * from the same snapshot. Covers the SQL the line-level engines depend on, which the unit tests
 * cannot reach.
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createSeries, invoicePayload, leaseBlock, today } from './setup/fixtures.js';
import { data, error } from './setup/body.js';
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

// Object storage is not configured for the test database, so uploads are captured in memory and
// the files themselves are inspected, which is a stronger check than a signed URL.
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

const fileFor = (res: { body: { data: { objectKey: string } } }): Buffer => {
  const buf = uploaded.get(res.body.data.objectKey);
  if (!buf) throw new Error('nothing was uploaded');
  return buf;
};

interface Sheet {
  id: string;
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
}
interface Workings {
  form: string;
  sheets: Sheet[];
  issues: { code: string; severity: string }[];
  summary: unknown[];
}
interface Period {
  id: string;
  status: string;
  totalTaxable: number;
  totalTax: number;
  workings: Workings | null;
}

describe('GSTR-1 and GSTR-3B', () => {
  let shop: TenantFixture;
  let gstin: string;
  let invoices: string;
  let credits: string;
  let itemId: string;
  let invoiceSeq = 0;
  let creditSeq = 0;
  const year = new Date().getUTCFullYear();
  const month = new Date().getUTCMonth() + 1;

  const customer = async (fields: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID();
    await shop
      .post('/v1/customers')
      .send({ id, name: 'A Buyer', addressLine1: '9 Station Road', stateCode: '27', ...fields })
      .expect(201);
    return id;
  };

  const bill = async (customerId: string | null) => {
    invoiceSeq += 1;
    const res = await shop.post('/v1/invoices').send(
      invoicePayload(shop, {
        seriesId: invoices,
        sequenceNo: invoiceSeq,
        customerId,
        lines: [{ itemId, quantity: 2000, unitPrice: 10_000, taxRatePercent: 18 }],
        // A walk-in bill is paid at the till; a named customer's goes on their khata.
        ...(customerId === null
          ? { payments: [{ id: randomUUID(), mode: 'cash', amount: 23_600 }] }
          : {}),
      }),
    );
    if (res.status !== 201)
      throw new Error(`bill failed ${res.status}: ${JSON.stringify(res.body)}`);
    return data<{ id: string; lines: { id: string }[] }>(res);
  };

  const open = async (returnType: 'gstr1' | 'gstr3b'): Promise<Period> => {
    // A period is unique per registration, form and month, so a second open returns the first.
    const created = await shop
      .post('/v1/gst/periods')
      .send({ id: randomUUID(), gstin, returnType, periodYear: year, periodMonth: month })
      .expect(201);
    const id = data<Period>(created).id;
    const res = await shop.post(`/v1/gst/periods/${id}/prepare`).expect(200);
    return data<Period>(res);
  };

  const sheet = (p: Period, id: string): Sheet => {
    const found = p.workings?.sheets.find((s) => s.id === id);
    if (!found) throw new Error(`no sheet ${id}`);
    return found;
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
        name: 'Cotton shirt',
        hsnCode: '6109',
        taxRatePercent: 18,
        unit: 'pcs',
        salePrice: 10_000,
        trackStock: false,
        pricesIncludeTax: false,
      })
      .expect(201);
    const series = async (documentType: string, prefix: string): Promise<string> => {
      const s = await createSeries(shop, { documentType, prefix });
      await leaseBlock(shop, s.id, 100);
      return s.id;
    };
    invoices = await series('invoice', 'INV');
    credits = await series('credit_note', 'CN');

    // Two bills to a registered buyer, one walk-in, and a value-only credit note on the first.
    const buyer = await customer({ gstin: validGstin('27') });
    const first = await bill(buyer);
    await bill(buyer);
    await bill(null);
    creditSeq += 1;
    await shop
      .post('/v1/credit-notes')
      .send({
        id: randomUUID(),
        originalInvoiceId: first.id,
        seriesId: credits,
        sequenceNo: creditSeq,
        documentDate: today(),
        issuedAt: new Date().toISOString(),
        lines: [{ id: randomUUID(), invoiceLineId: first.lines[0]?.id, valueAmount: 5000 }],
        reasonCode: 'price_correction',
        refundMode: 'khata',
      })
      .expect(201);
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  describe('GSTR-1', () => {
    let p: Period;
    beforeAll(async () => {
      p = await open('gstr1');
    });

    it('classifies the bills line by line and nets the credit note', () => {
      expect(p.status).toBe('prepared');
      expect(sheet(p, 'b2b').rows).toHaveLength(2);
      expect(sheet(p, 'b2b').totals['taxable']).toBe(40_000);
      expect(sheet(p, 'b2b').totals['cgst']).toBe(3_600);
      expect(sheet(p, 'b2cs').totals['taxable']).toBe(20_000);
      expect(sheet(p, 'cdnr').totals['taxable']).toBe(5_000);
      // 3 bills of 20,000 less the 5,000 credit.
      expect(p.totalTaxable).toBe(60_000 - 5_000);
    });

    it('reports documents issued from the number registry with the portal code', () => {
      const docs = sheet(p, 'docs');
      expect(docs.rows.find((r) => r['code'] === '1')).toMatchObject({
        total: 3,
        cancelled: 0,
        net: 3,
      });
      expect(docs.rows.find((r) => r['code'] === '5')).toMatchObject({ total: 1 });
    });

    it('has no listing page payload bloat: the period list leaves workings out', async () => {
      const res = await shop.get('/v1/gst/periods?returnType=gstr1').expect(200);
      const rows = (res.body as { data: { workings: unknown }[] }).data;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workings === null)).toBe(true);
    });

    it('exports the same tables as Excel and as the CA package', async () => {
      const x = await shop.get(`/v1/gst/periods/${p.id}/export?format=xlsx`).expect(200);
      expect(data<{ filename: string }>(x).filename).toMatch(/\.xlsx$/);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(fileFor(x) as never);
      const names = book.worksheets.map((w) => w.name);
      expect(names).toEqual(
        expect.arrayContaining(['b2b,sez,de', 'b2cs', 'cdnr', 'exemp', 'hsn_b2b', 'docs']),
      );
      // The workbook shows the figures the screen shows, in rupees: 2 bills of 200.00 taxable.
      const b2b = book.getWorksheet('b2b,sez,de');
      const lastRow = b2b?.getRow(b2b.rowCount);
      expect(lastRow?.getCell(1).value).toBe('Total');
      expect(Number(lastRow?.getCell(11).value)).toBe(400);

      const ca = await shop.get(`/v1/gst/periods/${p.id}/export?format=ca`).expect(200);
      expect(data<{ filename: string }>(ca).filename).toMatch(/CA-package\.xlsx$/);
      const caBook = new ExcelJS.Workbook();
      await caBook.xlsx.load(fileFor(ca) as never);
      expect(caBook.worksheets.map((w) => w.name).slice(0, 1)).toEqual(['Summary']);
      expect(caBook.worksheets.map((w) => w.name)).toContain('Issues');
    });

    it('produces portal JSON from the official Save schema, and says what it is', async () => {
      const res = await shop.get(`/v1/gst/periods/${p.id}/export?format=json`);
      expect(res.status).toBe(200);
      const body = data<{
        payloadStatus: string;
        mapperId: string;
        schemaSha256: string;
        filename: string;
      }>(res);
      expect(body.payloadStatus).toBe('portal_ready');
      expect(body.mapperId).toBe('gstr1-v2026.11');
      expect(body.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.filename).toMatch(/\.json$/);
      const payload = JSON.parse(fileFor(res).toString('utf8')) as Record<string, any>;
      expect(payload['gstin']).toBe(gstin);
      expect(payload['fp']).toBe(`${String(month).padStart(2, '0')}${year}`);
      expect(payload['b2b'][0].inv).toHaveLength(1 + 1);
      expect(payload['doc_issue'].doc_det_new.map((d: { doc_num: string }) => d.doc_num)).toEqual([
        '1',
        '5',
      ]);
    });
  });

  describe('GSTR-3B', () => {
    it('takes outward figures from the same bills and compares with the prepared GSTR-1', async () => {
      const p = await open('gstr3b');
      const outward = sheet(p, '3_1').rows.find((r) => r['key'] === 'a');
      expect(outward).toMatchObject({ taxable: 55_000, cgst: 4_950, sgst: 4_950 });
      expect(p.workings?.issues.some((i) => i.code === 'gstr1_changed_since_prepared')).toBe(false);
      expect(p.workings?.issues.some((i) => i.code === 'gstr2b_not_imported')).toBe(true);
    });

    it('exports portal JSON that passes the official Save schema', async () => {
      const p = await open('gstr3b');
      const res = await shop.get(`/v1/gst/periods/${p.id}/export?format=json`).expect(200);
      expect(data<{ payloadStatus: string }>(res).payloadStatus).toBe('portal_ready');
    });

    it('says when GSTR-1 changed after it was prepared', async () => {
      await bill(null);
      const p = await open('gstr3b');
      expect(
        p.workings?.issues.find((i) => i.code === 'gstr1_changed_since_prepared')?.severity,
      ).toBe('error');
    });
  });

  it('refuses to export a return that was never prepared', async () => {
    const id = randomUUID();
    await shop
      .post('/v1/gst/periods')
      .send({
        id,
        gstin,
        returnType: 'gstr1',
        periodYear: year,
        periodMonth: month === 1 ? 12 : month - 1,
      })
      .expect(201);
    const res = await shop.get(`/v1/gst/periods/${id}/export?format=json`).expect(422);
    expect(error(res).code).toBe('UNPROCESSABLE');
  });
});
