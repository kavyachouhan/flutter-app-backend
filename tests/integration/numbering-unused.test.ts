/**
 * Reserved numbers nobody used, declared cancelled so GSTR-1 Table 13 has no gap.
 *
 * A till reserves a block of numbers to bill offline. One that bills 1-3 of
 * 1-10 and is then retired, and a phone that reserved 11-15 and was lost,
 * leave 4-15 unused. Those must end up in Table 13 as cancelled, and must never
 * be usable again. But a number may only be declared once nothing can still be
 * issued under it: a till offline since its block expired may hold bills not
 * yet sent, so its numbers wait.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient, ownerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createSeries, invoicePayload, leaseBlock } from './setup/fixtures.js';
import { addMember } from './setup/orders.js';
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

interface Range {
  from: number;
  to: number;
  count: number;
  status: string;
}
interface Cancellation {
  cancelled: number;
  waiting: number;
  series: { seriesId: string; cancelled: Range[]; waiting: Range[] }[];
}
interface Period {
  id: string;
  workings: {
    sheets: { id: string; rows: Record<string, unknown>[] }[];
    issues: { code: string }[];
  } | null;
}

describe('unused reserved numbers', () => {
  let shop: TenantFixture;
  let phone: TenantFixture;
  let gstin: string;
  let seriesId: string;
  let itemId: string;
  let tillBlock: { id: string; startSeq: number; endSeq: number };
  let phoneBlock: { id: string; startSeq: number; endSeq: number };

  const bill = (sequenceNo: number) =>
    shop.post('/v1/invoices').send(
      invoicePayload(shop, {
        seriesId,
        sequenceNo,
        lines: [{ itemId, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
        payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
      }),
    );

  const gaps = async (): Promise<Range[]> =>
    data<Range[]>(await shop.get(`/v1/numbering/series/${seriesId}/gaps`).expect(200));

  const cancel = async (): Promise<Cancellation> =>
    data<Cancellation>(
      await shop.post('/v1/numbering/unused-numbers/cancel').send({ seriesId }).expect(200),
    );

  /** Moves a block's expiry, as time passing would. */
  const expireBlock = async (blockId: string, ago: string) => {
    const db = await ownerClient();
    await db.query(`UPDATE number_blocks SET expires_at = now() - $2::interval WHERE id = $1`, [
      blockId,
      ago,
    ]);
  };

  beforeAll(async () => {
    gstin = validGstin('27');
    shop = await createTenant({ stateCode: '27', gstin });
    phone = await addMember(shop, 'cashier');
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
    seriesId = (await createSeries(shop, { prefix: 'INV' })).id;
    tillBlock = await leaseBlock(shop, seriesId, 10);
    phoneBlock = await leaseBlock(phone, seriesId, 5);
    for (const n of [1, 2, 3]) expect((await bill(n)).status).toBe(201);
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('leased blocks still being billed from are not gaps', async () => {
    expect(tillBlock).toMatchObject({ startSeq: 1, endSeq: 10 });
    expect(phoneBlock).toMatchObject({ startSeq: 11, endSeq: 15 });
    expect(await gaps()).toEqual([]);
  });

  it('a till silent since its block expired keeps its numbers: it may hold unsent bills', async () => {
    // Expired ten minutes ago; the till was last in touch (signing in) before that grace ran out.
    await expireBlock(tillBlock.id, '10 minutes');
    expect(await gaps()).toEqual([{ from: 4, to: 10, count: 7, status: 'device_offline' }]);

    const result = await cancel();
    expect(result).toMatchObject({ cancelled: 0, waiting: 7 });
    expect((await bill(4)).status).toBe(201); // still the till's to use
  });

  it('once the till has been online since expiry, its unused numbers are declared cancelled', async () => {
    await expireBlock(tillBlock.id, '2 hours');
    expect(await gaps()).toEqual([{ from: 5, to: 10, count: 6, status: 'cancellable' }]);

    const result = await cancel();
    expect(result).toMatchObject({ cancelled: 6, waiting: 0 });
    expect(result.series[0]?.cancelled).toEqual([
      { from: 5, to: 10, count: 6, status: 'cancellable' },
    ]);
    expect(await gaps()).toEqual([]);

    // Declaring again finds nothing left to declare.
    expect(await cancel()).toMatchObject({ cancelled: 0, waiting: 0 });
  });

  it('a number declared cancelled is refused to any later upload', async () => {
    const res = await bill(5);
    expect(res.status).toBe(422);
    expect(error(res).code).toBe('NUMBER_NOT_LEASED');
  });

  it('removing a lost phone declares its unused numbers cancelled at once', async () => {
    await shop.post(`/v1/devices/${phone.deviceId}/deactivate`).expect(200);

    const db = await ownerClient();
    const rows = await db.query<{ sequence_no: string; reason: string; document_number: string }>(
      `SELECT sequence_no, reason, document_number FROM cancelled_document_numbers
       WHERE series_id = $1 AND block_id = $2 ORDER BY sequence_no`,
      [seriesId, phoneBlock.id],
    );
    expect(rows.rows.map((r) => Number(r.sequence_no))).toEqual([11, 12, 13, 14, 15]);
    expect(rows.rows.every((r) => r.reason === 'device_removed')).toBe(true);
    expect(rows.rows[0]?.document_number).toMatch(/^INV\/\d{2}-\d{2}\/0011$/);

    const block = await db.query<{ live: boolean }>(
      'SELECT expires_at > now() AS live FROM number_blocks WHERE id = $1',
      [phoneBlock.id],
    );
    expect(block.rows[0]?.live).toBe(false);
  });

  it('GSTR-1 Table 13 counts them as cancelled: no gap in the series', async () => {
    const now = new Date();
    const created = await shop
      .post('/v1/gst/periods')
      .send({
        id: randomUUID(),
        gstin,
        returnType: 'gstr1',
        periodYear: now.getUTCFullYear(),
        periodMonth: now.getUTCMonth() + 1,
      })
      .expect(201);
    const prepared = data<Period>(
      await shop.post(`/v1/gst/periods/${data<Period>(created).id}/prepare`).expect(200),
    );

    const docs = prepared.workings?.sheets.find((s) => s.id === 'docs');
    expect(docs?.rows.find((r) => r['code'] === '1')).toMatchObject({
      total: 15,
      cancelled: 11,
      net: 4,
    });
    expect(prepared.workings?.issues.map((i) => i.code)).not.toContain('document_number_gap');
  });
});
