/**
 * Sales orders: create / read / edit / delete, the totals the server insists
 * on, the advance as a real payment, T&C, status derived from fulfilment, and
 * the purchase-order edit/delete added alongside.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  today,
  type SeriesFixture,
} from './setup/fixtures.js';
import { data, error, rows } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

interface OrderLine {
  id: string;
  itemId: string | null;
  quantity: number;
  quantityFulfilled: number;
  quantityPending: number;
}

interface Order {
  id: string;
  documentNumber: string;
  status: 'open' | 'partial' | 'closed' | 'cancelled';
  grandTotal: number;
  advanceAmount: number;
  balanceDue: number;
  customerId: string | null;
  customerName: string | null;
  termsId: string | null;
  termsSnapshot: { title: string; description: string } | null;
  lines: OrderLine[];
}

// Every call is a round trip to a hosted database, and each order now does more of them.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('sales orders', () => {
  let t: TenantFixture;
  let series: SeriesFixture;
  let nextSeq = 0;

  const line = (itemId: string, quantity = 2000, unitPrice = 10_000) => ({
    id: randomUUID(),
    itemId,
    quantity,
    unitPrice,
    taxRatePercent: 18,
  });

  function orderPayload(
    lines: ReturnType<typeof line>[],
    extra: Record<string, unknown> = {},
    id: string = randomUUID(),
  ) {
    return {
      id,
      outletId: t.outletId,
      documentDate: today(),
      customerName: 'Walk-in Ravi',
      placeOfSupplyStateCode: '27',
      pricesIncludeTax: false,
      roundOff: false,
      lines,
      expectedTotals: expectedTotals(lines),
      ...extra,
    };
  }

  const create = async (payload: Record<string, unknown>, status = 201) =>
    t.post('/v1/sales-orders').send(payload).expect(status);

  async function invoiceAgainst(order: Order, quantities: number[], customerId?: string | null) {
    const lines = order.lines.map((l, i) => ({
      id: randomUUID(),
      itemId: l.itemId as string,
      quantity: quantities[i] ?? 0,
      unitPrice: 10_000,
      taxRatePercent: 18,
      salesOrderLineId: l.id,
    }));
    const used = lines.filter((l) => l.quantity > 0);
    const base = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: nextSeq++,
      customerId: customerId ?? order.customerId,
      lines: used,
    });
    return t.post('/v1/invoices').send({
      ...base,
      salesOrderId: order.id,
      lines: used.map((l) => ({ ...l })),
      expectedTotals: expectedTotals(used),
    });
  }

  beforeAll(async () => {
    t = await createTenant({ name: 'Orders Shop' });
    series = await createSeries(t, { prefix: 'ORD' });
    nextSeq = (await leaseBlock(t, series.id, 50)).startSeq;
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('creates an order with a generated SO number, and reads it back', async () => {
    const item = await createItem(t);
    const created = data<Order>(await create(orderPayload([line(item.id)])));
    expect(created.documentNumber).toMatch(/^SO/);
    expect(created.status).toBe('open');
    expect(created.grandTotal).toBe(23_600);
    expect(created.balanceDue).toBe(23_600);

    const read = data<Order>(await t.get(`/v1/sales-orders/${created.id}`).expect(200));
    expect(read.id).toBe(created.id);
    expect(read.lines).toHaveLength(1);
    expect(read.lines[0]?.quantityPending).toBe(2000);
  });

  it('replays a duplicate submission instead of creating a second order', async () => {
    const item = await createItem(t);
    const payload = orderPayload([line(item.id)]);
    const first = data<Order>(await create(payload, 201));
    const second = data<Order>(await create(payload, 200));
    expect(second.id).toBe(first.id);
    expect(second.documentNumber).toBe(first.documentNumber);
  });

  it('rejects missing customer, bad dates, negative price and bad quantity', async () => {
    const item = await createItem(t);
    const base = orderPayload([line(item.id)]);

    const noCustomer = { ...base, id: randomUUID(), customerName: undefined };
    expect(error(await create(noCustomer, 400)).code).toBe('VALIDATION_FAILED');

    const badDue = { ...base, id: randomUUID(), dueDate: '2000-01-01' };
    expect(error(await create(badDue, 400)).code).toBe('VALIDATION_FAILED');

    const negative = { ...base, id: randomUUID(), lines: [{ ...line(item.id), unitPrice: -5 }] };
    await create(negative, 400);

    const zeroQty = { ...base, id: randomUUID(), lines: [{ ...line(item.id), quantity: 0 }] };
    await create(zeroQty, 400);

    const unknownItem = orderPayload([line(randomUUID())]);
    await create(unknownItem, 404);
  });

  it('rejects tampered totals', async () => {
    const item = await createItem(t);
    const lines = [line(item.id)];
    const tampered = orderPayload(lines, {
      expectedTotals: { grandTotal: 1, totalTax: 0, taxableAmount: 1 },
    });
    expect(error(await create(tampered, 409)).code).toBe('TOTALS_MISMATCH');
  });

  it('computes tax, discount and totals with the shared engine', async () => {
    const item = await createItem(t);
    const discounted = [{ ...line(item.id, 1000, 10_000), discount: { kind: 'amount', value: 1_000 } }];
    // 10,000 - 1,000 = 9,000 taxable; 18% = 1,620 -> 10,620
    const order = data<Order>(
      await create(
        orderPayload(discounted, {
          expectedTotals: { taxableAmount: 9_000, totalTax: 1_620, grandTotal: 10_620 },
        }),
      ),
    );
    expect(order.grandTotal).toBe(10_620);
  });

  it('accepts an order with no items and a typed total, but not both', async () => {
    const manual = data<Order>(
      await create(
        orderPayload([], {
          manualTotal: 50_000,
          expectedTotals: { grandTotal: 50_000, totalTax: 0, taxableAmount: 50_000 },
        }),
      ),
    );
    expect(manual.grandTotal).toBe(50_000);
    expect(manual.lines).toHaveLength(0);

    await create(orderPayload([], { expectedTotals: expectedTotals([]) }), 400);

    const item = await createItem(t);
    await create(orderPayload([line(item.id)], { manualTotal: 1 }), 400);
  });

  describe('advance', () => {
    it('records a real payment and a khata credit, and computes the balance due', async () => {
      const item = await createItem(t);
      const customer = await createCustomer(t);
      const order = data<Order>(
        await create(
          orderPayload([line(item.id)], {
            customerId: customer.id,
            advanceAmount: 10_000,
            paymentMode: 'upi',
          }),
        ),
      );
      expect(order.advanceAmount).toBe(10_000);
      expect(order.balanceDue).toBe(13_600);
      // The advance is a payment fact, not fulfilment.
      expect(order.status).toBe('open');

      const read = data<{ balance: number }>(
        await t.get(`/v1/customers/${customer.id}`).expect(200),
      );
      expect(read.balance).toBe(-10_000);
    });

    it('refuses an advance above the total, without a customer, or without a mode', async () => {
      const item = await createItem(t);
      const customer = await createCustomer(t);
      const over = orderPayload([line(item.id)], {
        customerId: customer.id,
        advanceAmount: 99_999,
        paymentMode: 'cash',
      });
      expect(error(await create(over, 422)).code).toBe('OVERPAYMENT');

      const noCustomer = orderPayload([line(item.id)], { advanceAmount: 100, paymentMode: 'cash' });
      expect(error(await create(noCustomer, 422)).code).toBe('CREDIT_SALE_REQUIRES_CUSTOMER');

      const noMode = orderPayload([line(item.id)], { customerId: customer.id, advanceAmount: 100 });
      await create(noMode, 400);
    });

    it('swaps the payment when the advance is edited and reverses it on delete', async () => {
      const item = await createItem(t);
      const customer = await createCustomer(t);
      const lines = [line(item.id)];
      const order = data<Order>(
        await create(
          orderPayload(lines, { customerId: customer.id, advanceAmount: 5_000, paymentMode: 'cash' }),
        ),
      );
      const balance = async () =>
        data<{ balance: number }>(await t.get(`/v1/customers/${customer.id}`).expect(200)).balance;
      expect(await balance()).toBe(-5_000);

      const { id: _ignored, ...body } = orderPayload(lines, {
        customerId: customer.id,
        advanceAmount: 8_000,
        paymentMode: 'cash',
      });
      void _ignored;
      await t.put(`/v1/sales-orders/${order.id}`).send(body).expect(200);
      expect(await balance()).toBe(-8_000);

      // The advance may already be banked, so deleting pays it back rather than erasing it.
      const deleted = await t.del(`/v1/sales-orders/${order.id}`).expect(200);
      expect((deleted.body as { data: { refund: { paidOut: boolean } } }).data.refund.paidOut).toBe(true);
      expect(await balance()).toBe(0);
      await t.get(`/v1/sales-orders/${order.id}`).expect(404);
    });
  });

  describe('terms and conditions', () => {
    async function createTerms(applicableFor: string[]) {
      return data<{ id: string; title: string }>(
        await t
          .post('/v1/terms')
          .send({ id: randomUUID(), title: 'Order terms', description: 'Advance is non-refundable', applicableFor })
          .expect(201),
      );
    }

    it('snapshots applicable terms, lets them be changed or removed, and survives reopening', async () => {
      const item = await createItem(t);
      const terms = await createTerms(['sale_order']);
      const lines = [line(item.id)];
      const order = data<Order>(await create(orderPayload(lines, { termsId: terms.id })));
      expect(order.termsId).toBe(terms.id);
      expect(order.termsSnapshot?.description).toBe('Advance is non-refundable');

      // Later edits to the master do not rewrite the stored snapshot.
      await t.patch(`/v1/terms/${terms.id}`).send({ description: 'Changed' }).expect(200);
      const reopened = data<Order>(await t.get(`/v1/sales-orders/${order.id}`).expect(200));
      expect(reopened.termsSnapshot?.description).toBe('Advance is non-refundable');

      const { id: _i, ...body } = orderPayload(lines, { termsId: null });
      void _i;
      const cleared = data<Order>(await t.put(`/v1/sales-orders/${order.id}`).send(body).expect(200));
      expect(cleared.termsId).toBeNull();
      expect(cleared.termsSnapshot).toBeNull();
    });

    it('rejects terms that are not applicable to sale orders', async () => {
      const item = await createItem(t);
      const purchaseOnly = await createTerms(['purchase']);
      await create(orderPayload([line(item.id)], { termsId: purchaseOnly.id }), 422);
    });
  });

  describe('status and fulfilment', () => {
    it('moves open -> partial -> closed as invoices fulfil it, and back on void', async () => {
      const itemA = await createItem(t);
      const itemB = await createItem(t);
      const customer = await createCustomer(t);
      const order = data<Order>(
        await create(
          orderPayload([line(itemA.id, 2000), line(itemB.id, 1000)], { customerId: customer.id }),
        ),
      );

      const partial = await invoiceAgainst(order, [1000, 0]);
      expect(partial.status).toBe(201);
      const afterPartial = data<Order>(await t.get(`/v1/sales-orders/${order.id}`).expect(200));
      expect(afterPartial.status).toBe('partial');
      expect(afterPartial.lines[0]?.quantityFulfilled).toBe(1000);

      const rest = await invoiceAgainst(afterPartial, [1000, 1000]);
      expect(rest.status).toBe(201);
      const closed = data<Order>(await t.get(`/v1/sales-orders/${order.id}`).expect(200));
      expect(closed.status).toBe('closed');

      const invoiceId = data<{ id: string }>(rest).id;
      await t.post(`/v1/invoices/${invoiceId}/void`).send({ reason: 'wrong' }).expect(200);
      const reopened = data<Order>(await t.get(`/v1/sales-orders/${order.id}`).expect(200));
      expect(reopened.status).toBe('partial');
    });

    it('refuses to over-fulfil a line or invoice a different customer', async () => {
      const item = await createItem(t);
      const customer = await createCustomer(t);
      const other = await createCustomer(t);
      const order = data<Order>(
        await create(orderPayload([line(item.id, 1000)], { customerId: customer.id })),
      );

      const over = await invoiceAgainst(order, [5000]);
      expect(over.status).toBe(422);
      expect(error(over).code).toBe('FULFILMENT_EXCEEDS_ORDER');

      const wrongCustomer = await invoiceAgainst(order, [1000], other.id);
      expect(wrongCustomer.status).toBe(422);
    });

    it('filters the list and summary against persisted data', async () => {
      const fresh = await createTenant({ name: 'Filter Shop' });
      const s = await createSeries(fresh, { prefix: 'FLT' });
      const seq = (await leaseBlock(fresh, s.id, 10)).startSeq;
      const item = await createItem(fresh);
      const customer = await createCustomer(fresh);

      const make = async () => {
        const lines = [line(item.id, 1000)];
        const res = await fresh
          .post('/v1/sales-orders')
          .send({ ...orderPayload(lines, { customerId: customer.id }), outletId: fresh.outletId })
          .expect(201);
        return data<Order>(res);
      };
      const open = await make();
      const toClose = await make();
      const toPartial = await make();
      await fresh.post(`/v1/sales-orders/${toClose.id}/close`).expect(200);

      // Two-line order, one line fulfilled -> partial.
      const itemB = await createItem(fresh);
      const twoLines = [line(item.id, 1000), line(itemB.id, 1000)];
      const two = data<Order>(
        await fresh
          .post('/v1/sales-orders')
          .send({ ...orderPayload(twoLines, { customerId: customer.id }), outletId: fresh.outletId })
          .expect(201),
      );
      const fulfil = [{ id: randomUUID(), itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18, salesOrderLineId: two.lines[0]?.id }];
      await fresh
        .post('/v1/invoices')
        .send({
          ...invoicePayload(fresh, {
            seriesId: s.id,
            sequenceNo: seq,
            customerId: customer.id,
            lines: fulfil,
          }),
          salesOrderId: two.id,
          lines: fulfil,
          expectedTotals: expectedTotals(fulfil as never),
        })
        .expect(201);

      const ids = async (status: string) =>
        rows<Order>(await fresh.get(`/v1/sales-orders?status=${status}`).expect(200)).map((o) => o.id);
      expect(await ids('open')).toEqual(expect.arrayContaining([open.id, toPartial.id]));
      expect(await ids('open')).not.toContain(toClose.id);
      expect(await ids('closed')).toEqual([toClose.id]);
      expect(await ids('partial')).toEqual([two.id]);
      expect((await ids('all')).length).toBe(4);

      const summary = data<{ all: number; open: number; partial: number; closed: number }>(
        await fresh.get('/v1/sales-orders/summary').expect(200),
      );
      expect(summary).toEqual({ all: 4, open: 2, partial: 1, closed: 1 });
    });
  });

  describe('editing and deleting', () => {
    it('replaces header and lines atomically and keeps the order number', async () => {
      const a = await createItem(t);
      const b = await createItem(t);
      const lines = [line(a.id, 1000)];
      const order = data<Order>(await create(orderPayload(lines)));

      const newLines = [lines[0] as ReturnType<typeof line>, line(b.id, 3000)];
      const { id: _i, ...body } = orderPayload(newLines, { customerName: 'Renamed' });
      void _i;
      const edited = data<Order>(await t.put(`/v1/sales-orders/${order.id}`).send(body).expect(200));
      expect(edited.documentNumber).toBe(order.documentNumber);
      expect(edited.customerName).toBe('Renamed');
      expect(edited.lines).toHaveLength(2);
      expect(edited.grandTotal).toBe(expectedTotals(newLines).grandTotal);
    });

    it('locks invoiced lines: no removal, no drop below fulfilled, no delete', async () => {
      const a = await createItem(t);
      const b = await createItem(t);
      const customer = await createCustomer(t);
      const lines = [line(a.id, 2000), line(b.id, 1000)];
      const order = data<Order>(await create(orderPayload(lines, { customerId: customer.id })));
      await invoiceAgainst(order, [2000, 0]).then((r) => expect(r.status).toBe(201));

      const dropLine = orderPayload([lines[1] as ReturnType<typeof line>], { customerId: customer.id });
      const { id: _a, ...dropBody } = dropLine;
      void _a;
      await t.put(`/v1/sales-orders/${order.id}`).send(dropBody).expect(422);

      const shrunk = [{ ...(lines[0] as ReturnType<typeof line>), quantity: 1000 }, lines[1] as ReturnType<typeof line>];
      const { id: _b, ...shrunkBody } = orderPayload(shrunk, { customerId: customer.id });
      void _b;
      expect(error(await t.put(`/v1/sales-orders/${order.id}`).send(shrunkBody).expect(422)).code).toBe(
        'FULFILMENT_EXCEEDS_ORDER',
      );

      await t.del(`/v1/sales-orders/${order.id}`).expect(422);
    });

    it('cancels an unfulfilled order and then refuses edits', async () => {
      const item = await createItem(t);
      const lines = [line(item.id)];
      const order = data<Order>(await create(orderPayload(lines)));
      const cancelled = data<Order>(
        await t.post(`/v1/sales-orders/${order.id}/cancel`).send({ reason: 'changed mind' }).expect(200),
      );
      expect(cancelled.status).toBe('cancelled');
      const { id: _i, ...body } = orderPayload(lines);
      void _i;
      await t.put(`/v1/sales-orders/${order.id}`).send(body).expect(422);
    });
  });

  describe('authorisation and isolation', () => {
    it('answers 404 for another business and 401 without a token', async () => {
      const item = await createItem(t);
      const order = data<Order>(await create(orderPayload([line(item.id)])));
      const stranger = await createTenant({ name: 'Other Shop' });
      await stranger.get(`/v1/sales-orders/${order.id}`).expect(404);
      await stranger.del(`/v1/sales-orders/${order.id}`).expect(404);
      expect(rows<Order>(await stranger.get('/v1/sales-orders').expect(200))).toHaveLength(0);

      const { app } = await import('./setup/tenant.js');
      const request = (await import('supertest')).default;
      await request(app).get('/v1/sales-orders').expect(401);
    });

    it('rejects an attachment key from another business', async () => {
      const item = await createItem(t);
      const other = await createTenant({ name: 'Key Owner' });
      const payload = orderPayload([line(item.id)], {
        attachments: [{ objectKey: `${other.tenantId}/order_attachment/x.png`, kind: 'image' }],
      });
      await create(payload, 403);
    });
  });

  describe('purchase orders: edit and delete', () => {
    async function supplier() {
      const id = randomUUID();
      await t.post('/v1/suppliers').send({ id, name: `Supplier ${id.slice(0, 6)}` }).expect(201);
      return id;
    }

    it('edits an unreceived order, then deletes it', async () => {
      const supplierId = await supplier();
      const item = await createItem(t);
      const id = randomUUID();
      const lineId = randomUUID();
      await t
        .post('/v1/purchase-orders')
        .send({
          id,
          outletId: t.outletId,
          supplierId,
          documentDate: today(),
          lines: [{ id: lineId, itemId: item.id, quantityOrdered: 5000, expectedUnitCost: 1_000 }],
        })
        .expect(201);

      const edited = data<{ lines: { id: string; quantityOrdered: number }[] }>(
        await t
          .put(`/v1/purchase-orders/${id}`)
          .send({
            outletId: t.outletId,
            supplierId,
            documentDate: today(),
            notes: 'edited',
            lines: [{ id: lineId, itemId: item.id, quantityOrdered: 8000, expectedUnitCost: 1_200 }],
          })
          .expect(200),
      );
      expect(edited.lines[0]?.quantityOrdered).toBe(8000);

      await t.del(`/v1/purchase-orders/${id}`).expect(204);
      await t.get(`/v1/purchase-orders/${id}`).expect(404);
    });
  });
});
