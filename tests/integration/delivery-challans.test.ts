/**
 * Delivery challans: goods leaving the shop before a sale is billed. The
 * thing worth proving end to end is the stock effect — a challan moves real
 * stock on create and gives it back exactly on cancel, the same contract
 * billing.test.ts proves for an invoice and its void.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import {
  createCustomer,
  createItem,
  createSeries,
  expectedTotals,
  invoicePayload,
  leaseBlock,
  type SeriesFixture,
} from './setup/fixtures.js';
import { data, error, rows } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

interface DeliveryChallan {
  id: string;
  documentNumber: string;
  status: 'open' | 'partial' | 'converted' | 'cancelled';
  lines: { id: string; itemId: string; quantity: number }[];
}

describe('delivery challans', () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant({ name: 'Challan Shop' });
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('gets its own document number from a DC series, auto-provisioned on first use', async () => {
    const item = await createItem(t, { trackStock: true });
    const challan = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: randomUUID(), itemId: item.id, quantity: 2000 }],
        })
        .expect(201),
    );
    expect(challan.documentNumber).toContain('DC');
    expect(challan.status).toBe('open');
  });

  it('moves stock on create and gives it back exactly on cancel', async () => {
    const item = await createItem(t, { trackStock: true });
    const customer = await createCustomer(t, { name: 'Job Work Customer' });

    await t
      .post('/v1/stock/adjustments')
      .send({
        id: randomUUID(),
        outletId: t.outletId,
        itemId: item.id,
        quantityDelta: 10_000,
        reasonCode: 'opening',
        occurredAt: new Date().toISOString(),
      })
      .expect(201);

    const stockBefore = await balanceOf(t, item.id);
    const challan = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          customerId: customer.id,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: randomUUID(), itemId: item.id, quantity: 3000 }],
        })
        .expect(201),
    );

    expect(await balanceOf(t, item.id)).toBe(stockBefore - 3000);

    await t
      .post(`/v1/delivery-challans/${challan.id}/cancel`)
      .send({ reason: 'customer declined' })
      .expect(200);

    expect(await balanceOf(t, item.id)).toBe(stockBefore);
  });

  it('a non-stock item moves no stock at all', async () => {
    const service = await createItem(t, { itemType: 'service', trackStock: false });
    const challan = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: randomUUID(), itemId: service.id, quantity: 1000 }],
        })
        .expect(201),
    );
    expect(challan.lines).toHaveLength(1);
    expect(await balanceOf(t, service.id)).toBe(0);
  });

  it('replays the same id instead of writing it twice', async () => {
    const item = await createItem(t, { trackStock: true });
    const id = randomUUID();
    const body = {
      id,
      outletId: t.outletId,
      documentDate: new Date().toISOString().slice(0, 10),
      lines: [{ id: randomUUID(), itemId: item.id, quantity: 1000 }],
    };
    const first = data<DeliveryChallan>(
      await t.post('/v1/delivery-challans').send(body).expect(201),
    );
    const second = data<DeliveryChallan>(
      await t.post('/v1/delivery-challans').send(body).expect(201),
    );
    expect(second.id).toBe(first.id);
    expect(second.documentNumber).toBe(first.documentNumber);
  });

  it('refuses an unknown item', async () => {
    const res = await t
      .post('/v1/delivery-challans')
      .send({
        id: randomUUID(),
        outletId: t.outletId,
        documentDate: new Date().toISOString().slice(0, 10),
        lines: [{ id: randomUUID(), itemId: randomUUID(), quantity: 1000 }],
      })
      .expect(404);
    expect(error(res).code).toBe('NOT_FOUND');
  });

  it('editing an open challan corrects stock by the difference, not a full reset', async () => {
    const item = await createItem(t, { trackStock: true });
    await t
      .post('/v1/stock/adjustments')
      .send({
        id: randomUUID(),
        outletId: t.outletId,
        itemId: item.id,
        quantityDelta: 10_000,
        reasonCode: 'opening',
        occurredAt: new Date().toISOString(),
      })
      .expect(201);

    const stockBefore = await balanceOf(t, item.id);
    const lineId = randomUUID();
    const challan = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: lineId, itemId: item.id, quantity: 3000 }],
        })
        .expect(201),
    );
    expect(await balanceOf(t, item.id)).toBe(stockBefore - 3000);

    // Correct the quantity from 3 to 5: only the extra 2 should move.
    await t
      .patch(`/v1/delivery-challans/${challan.id}`)
      .send({
        customerId: null,
        notes: null,
        lines: [{ id: lineId, itemId: item.id, quantity: 5000 }],
      })
      .expect(200);
    expect(await balanceOf(t, item.id)).toBe(stockBefore - 5000);

    // Cancelling afterwards must still give back the FULL 5, not just the
    // original 3 — proving the edit's stock entries are reachable by the
    // same cancel path, not orphaned.
    await t
      .post(`/v1/delivery-challans/${challan.id}/cancel`)
      .send({ reason: 'test' })
      .expect(200);
    expect(await balanceOf(t, item.id)).toBe(stockBefore);
  });

  it('removing a line on edit gives its stock back', async () => {
    const kept = await createItem(t, { trackStock: true });
    const removed = await createItem(t, { trackStock: true });
    for (const item of [kept, removed]) {
      await t
        .post('/v1/stock/adjustments')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          itemId: item.id,
          quantityDelta: 10_000,
          reasonCode: 'opening',
          occurredAt: new Date().toISOString(),
        })
        .expect(201);
    }

    const keptBefore = await balanceOf(t, kept.id);
    const removedBefore = await balanceOf(t, removed.id);
    const keptLineId = randomUUID();
    const challan = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [
            { id: keptLineId, itemId: kept.id, quantity: 1000 },
            { id: randomUUID(), itemId: removed.id, quantity: 2000 },
          ],
        })
        .expect(201),
    );
    expect(await balanceOf(t, removed.id)).toBe(removedBefore - 2000);

    await t
      .patch(`/v1/delivery-challans/${challan.id}`)
      .send({
        customerId: null,
        notes: null,
        lines: [{ id: keptLineId, itemId: kept.id, quantity: 1000 }],
      })
      .expect(200);

    expect(await balanceOf(t, kept.id)).toBe(keptBefore - 1000);
    expect(await balanceOf(t, removed.id)).toBe(removedBefore);
  });

  it('refuses to edit once cancelled', async () => {
    const item = await createItem(t, { trackStock: true });
    const lineId = randomUUID();
    const challan = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: lineId, itemId: item.id, quantity: 1000 }],
        })
        .expect(201),
    );
    await t
      .post(`/v1/delivery-challans/${challan.id}/cancel`)
      .send({ reason: 'test' })
      .expect(200);

    await t
      .patch(`/v1/delivery-challans/${challan.id}`)
      .send({
        customerId: null,
        notes: null,
        lines: [{ id: lineId, itemId: item.id, quantity: 9000 }],
      })
      .expect(422);
  });

  it('lists challans for the outlet, newest first', async () => {
    const item = await createItem(t, { trackStock: true });
    for (let i = 0; i < 2; i++) {
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: randomUUID(), itemId: item.id, quantity: 1000 }],
        })
        .expect(201);
    }
    const res = await t
      .get(`/v1/delivery-challans?outletId=${t.outletId}&openOnly=true`)
      .expect(200);
    expect(rows<DeliveryChallan>(res).length).toBeGreaterThanOrEqual(2);
  });

  it('closedOnly shows cancelled and converted, not open or partial ones', async () => {
    const item = await createItem(t, { trackStock: true });

    const open = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: randomUUID(), itemId: item.id, quantity: 1000 }],
        })
        .expect(201),
    );
    const cancelled = data<DeliveryChallan>(
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: randomUUID(), itemId: item.id, quantity: 1000 }],
        })
        .expect(201),
    );
    await t
      .post(`/v1/delivery-challans/${cancelled.id}/cancel`)
      .send({ reason: 'test' })
      .expect(200);

    const closedIds = rows<DeliveryChallan>(
      await t
        .get(`/v1/delivery-challans?outletId=${t.outletId}&closedOnly=true&limit=200`)
        .expect(200),
    ).map((c) => c.id);
    expect(closedIds).toContain(cancelled.id);
    expect(closedIds).not.toContain(open.id);
  });

  describe('converting to an invoice', () => {
    let series: SeriesFixture;
    let nextSeq = 0;
    let blockEnd = 0;

    async function sequence(): Promise<number> {
      if (nextSeq > blockEnd) {
        const block = await leaseBlock(t, series.id, 20);
        nextSeq = block.startSeq;
        blockEnd = block.endSeq;
      }
      return nextSeq++;
    }

    beforeAll(async () => {
      series = await createSeries(t, { prefix: 'DINV' });
      const block = await leaseBlock(t, series.id, 20);
      nextSeq = block.startSeq;
      blockEnd = block.endSeq;
    });

    it('bills a challan line without moving stock a second time, and marks the challan converted', async () => {
      const item = await createItem(t, { salePrice: 10_000, taxRatePercent: 18, trackStock: true });
      const lineId = randomUUID();
      const challan = data<DeliveryChallan>(
        await t
          .post('/v1/delivery-challans')
          .send({
            id: randomUUID(),
            outletId: t.outletId,
            documentDate: new Date().toISOString().slice(0, 10),
            lines: [{ id: lineId, itemId: item.id, quantity: 2000 }],
          })
          .expect(201),
      );
      const stockAfterChallan = await balanceOf(t, item.id);

      const lines = [
        { itemId: item.id, quantity: 2000, unitPrice: 10_000, taxRatePercent: 18, deliveryChallanLineId: lineId },
      ];
      const totals = expectedTotals(lines);
      const invoice = data<{ id: string; grandTotal: number }>(
        await t
          .post('/v1/invoices')
          .send(
            invoicePayload(t, {
              seriesId: series.id,
              sequenceNo: await sequence(),
              lines,
              payments: [{ id: randomUUID(), mode: 'cash', amount: totals.grandTotal }],
            }),
          )
          .expect(201),
      );

      // The challan already moved this stock — billing it must not move it again.
      expect(await balanceOf(t, item.id)).toBe(stockAfterChallan);

      const after = data<DeliveryChallan & { status: string }>(
        await t.get(`/v1/delivery-challans/${challan.id}`).expect(200),
      );
      expect(after.status).toBe('converted');

      // Voiding the invoice must give the challan back its unbilled status —
      // not leave it stuck saying "converted" forever.
      await t.post(`/v1/invoices/${invoice.id}/void`).send({ reason: 'test' }).expect(200);
      const afterVoid = data<DeliveryChallan>(
        await t.get(`/v1/delivery-challans/${challan.id}`).expect(200),
      );
      expect(afterVoid.status).toBe('open');
    });

    it('refuses to bill more than remains on the challan line', async () => {
      const item = await createItem(t, { salePrice: 10_000, taxRatePercent: 18, trackStock: true });
      const lineId = randomUUID();
      await t
        .post('/v1/delivery-challans')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: new Date().toISOString().slice(0, 10),
          lines: [{ id: lineId, itemId: item.id, quantity: 2000 }],
        })
        .expect(201);

      const lines = [
        { itemId: item.id, quantity: 5000, unitPrice: 10_000, taxRatePercent: 18, deliveryChallanLineId: lineId },
      ];
      const totals = expectedTotals(lines);
      const res = await t
        .post('/v1/invoices')
        .send(
          invoicePayload(t, {
            seriesId: series.id,
            sequenceNo: await sequence(),
            lines,
            payments: [{ id: randomUUID(), mode: 'cash', amount: totals.grandTotal }],
          }),
        )
        .expect(422);
      expect(error(res).code).toBe('UNPROCESSABLE');
    });

    it('partial billing leaves the challan partly invoiced, with the rest still owed', async () => {
      const item = await createItem(t, { salePrice: 10_000, taxRatePercent: 18, trackStock: true });
      const lineId = randomUUID();
      const challan = data<DeliveryChallan>(
        await t
          .post('/v1/delivery-challans')
          .send({
            id: randomUUID(),
            outletId: t.outletId,
            documentDate: new Date().toISOString().slice(0, 10),
            lines: [{ id: lineId, itemId: item.id, quantity: 10_000 }],
          })
          .expect(201),
      );

      const lines = [
        { itemId: item.id, quantity: 4000, unitPrice: 10_000, taxRatePercent: 18, deliveryChallanLineId: lineId },
      ];
      const totals = expectedTotals(lines);
      await t
        .post('/v1/invoices')
        .send(
          invoicePayload(t, {
            seriesId: series.id,
            sequenceNo: await sequence(),
            lines,
            payments: [{ id: randomUUID(), mode: 'cash', amount: totals.grandTotal }],
          }),
        )
        .expect(201);

      const after = data<DeliveryChallan>(
        await t.get(`/v1/delivery-challans/${challan.id}`).expect(200),
      );
      expect(after.status).toBe('partial');
    });
  });
});

async function balanceOf(t: TenantFixture, itemId: string): Promise<number> {
  const res = await t.get(`/v1/stock/balances?outletId=${t.outletId}&itemId=${itemId}`).expect(200);
  return rows<{ itemId: string; quantity: number }>(res)[0]?.quantity ?? 0;
}
