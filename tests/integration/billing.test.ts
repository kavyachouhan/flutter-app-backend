/**
 * The full billing path, plus the guarantees that make it safe to accept work
 * an offline device did hours ago: replay idempotency, document immutability,
 * and ledger-derived balances that survive a void exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient, ownerClient } from './setup/database.js';
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

interface Invoice {
  id: string;
  documentNumber: string;
  grandTotal: number;
  status: 'issued' | 'void';
  amountPaid: number;
}

describe('billing', () => {
  let t: TenantFixture;
  let series: SeriesFixture;
  let nextSeq = 0;
  let blockEnd = 0;

  /** Pulls the next leased number, leasing another block when exhausted. */
  async function sequence(): Promise<number> {
    if (nextSeq > blockEnd) {
      const block = await leaseBlock(t, series.id, 20);
      nextSeq = block.startSeq;
      blockEnd = block.endSeq;
    }
    return nextSeq++;
  }

  beforeAll(async () => {
    t = await createTenant({ name: 'Billing Shop' });
    series = await createSeries(t, { prefix: 'BILL' });
    const block = await leaseBlock(t, series.id, 20);
    nextSeq = block.startSeq;
    blockEnd = block.endSeq;
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('issues an invoice and computes GST the same way the client did', async () => {
    const item = await createItem(t, { salePrice: 10_000, taxRatePercent: 18 });
    const lines = [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }];
    const totals = expectedTotals(lines);

    // Paid in full: an unpaid invoice with no customer is refused outright,
    // which is its own test below.
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: await sequence(),
      lines,
      payments: [{ id: randomUUID(), mode: 'cash', amount: totals.grandTotal }],
    });
    const invoice = data<Invoice>(await t.post('/v1/invoices').send(payload).expect(201));

    expect(invoice.grandTotal).toBe(totals.grandTotal);
    expect(invoice.grandTotal).toBe(11_800);
    expect(invoice.documentNumber).toContain('BILL');
    expect(invoice.status).toBe('issued');
  });

  it('rejects totals that disagree with the server', async () => {
    const item = await createItem(t);
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: await sequence(),
      lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
      totalsOverride: { grandTotal: 1, totalTax: 1, taxableAmount: 1 },
    });
    const res = await t.post('/v1/invoices').send(payload).expect(409);
    expect(error(res).code).toBe('TOTALS_MISMATCH');
  });

  it('refuses a number the device never leased', async () => {
    const item = await createItem(t);
    const payload = invoicePayload(t, {
      seriesId: series.id,
      // Far beyond any leased block.
      sequenceNo: 900_000,
      lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
    });
    const res = await t.post('/v1/invoices').send(payload).expect(422);
    expect(error(res).code).toBe('NUMBER_NOT_LEASED');
  });

  // An offline device retries uploads; a retry must not bill the customer twice.
  it('replays an upload instead of creating a second invoice', async () => {
    const item = await createItem(t);
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: await sequence(),
      lines: [{ itemId: item.id, quantity: 2000, unitPrice: 5_000, taxRatePercent: 18 }],
      payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
    });

    const first = await t.post('/v1/invoices').send(payload).expect(201);
    const second = await t.post('/v1/invoices').send(payload).expect(200);
    expect(data<Invoice>(second).id).toBe(data<Invoice>(first).id);

    const c = await ownerClient();
    const { rows: found } = await c.query<{ count: string }>(
      'SELECT count(*) AS count FROM invoices WHERE id = $1',
      [payload.id],
    );
    expect(Number(found[0]?.count)).toBe(1);
  });

  it('moves stock and khata, then restores both exactly on void', async () => {
    const item = await createItem(t, { salePrice: 10_000, trackStock: true });
    const customer = await createCustomer(t, { name: 'Khata Customer' });

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
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: await sequence(),
      customerId: customer.id,
      lines: [{ itemId: item.id, quantity: 3000, unitPrice: 10_000, taxRatePercent: 18 }],
    });
    const invoice = data<Invoice>(await t.post('/v1/invoices').send(payload).expect(201));

    expect(await balanceOf(t, item.id)).toBe(stockBefore - 3000);
    // Unpaid, so the whole total sits on the customer's khata.
    expect(await khataOf(t, customer.id)).toBe(invoice.grandTotal);

    await t.post(`/v1/invoices/${invoice.id}/void`).send({ reason: 'test void' }).expect(200);

    expect(await balanceOf(t, item.id)).toBe(stockBefore);
    expect(await khataOf(t, customer.id)).toBe(0);
  });

  it('keeps the number of a voided invoice', async () => {
    const item = await createItem(t);
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: await sequence(),
      lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
      payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
    });
    const invoice = data<Invoice>(await t.post('/v1/invoices').send(payload).expect(201));
    await t.post(`/v1/invoices/${invoice.id}/void`).send({ reason: 'cancelled' }).expect(200);

    const after = data<Invoice>(await t.get(`/v1/invoices/${invoice.id}`).expect(200));
    expect(after.status).toBe('void');
    // GST requires the series to account for it, so the number is not reused.
    expect(after.documentNumber).toBe(invoice.documentNumber);
  });

  it('rejects an unpaid invoice with nobody to owe it', async () => {
    const item = await createItem(t);
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: await sequence(),
      customerId: null,
      lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
    });
    const res = await t.post('/v1/invoices').send(payload).expect(422);
    expect(error(res).code).toBe('CREDIT_SALE_REQUIRES_CUSTOMER');
  });

  it('settles khata through a receipt', async () => {
    const item = await createItem(t);
    const customer = await createCustomer(t, { name: 'Paying Customer' });
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: await sequence(),
      customerId: customer.id,
      lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
    });
    const invoice = data<Invoice>(await t.post('/v1/invoices').send(payload).expect(201));
    expect(await khataOf(t, customer.id)).toBe(invoice.grandTotal);

    await t
      .post('/v1/payments')
      .send({
        id: randomUUID(),
        outletId: t.outletId,
        customerId: customer.id,
        mode: 'cash',
        amount: invoice.grandTotal,
        receivedAt: new Date().toISOString(),
        allocations: [{ invoiceId: invoice.id, amount: invoice.grandTotal }],
      })
      .expect(201);

    expect(await khataOf(t, customer.id)).toBe(0);
  });
});

async function balanceOf(t: TenantFixture, itemId: string): Promise<number> {
  const res = await t.get(`/v1/stock/balances?outletId=${t.outletId}&itemId=${itemId}`).expect(200);
  return rows<{ itemId: string; quantity: number }>(res)[0]?.quantity ?? 0;
}

async function khataOf(t: TenantFixture, customerId: string): Promise<number> {
  const res = await t.get(`/v1/customers/${customerId}`).expect(200);
  return data<{ balance: number }>(res).balance;
}
