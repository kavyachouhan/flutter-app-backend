/**
 * Sales orders, round 2: plan gating and roles, stock reservation, advance refunds and
 * its application to invoices, editing after invoicing, invoice amendment, custom items,
 * bill-level discounts, and parity with invoices.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  today,
} from './setup/fixtures.js';
import { data, error, rows } from './setup/body.js';
import {
  addMember,
  balanceOf,
  createOrder,
  getOrder,
  orderBody,
  orderInvoiceRequest,
  orderLine,
  setAllowNegativeStock,
  setPlan,
  stockIn,
  type InvoiceSeries,
  type OrderView,
} from './setup/orders.js';
import { closePool } from '../../src/db/pool.js';

// Every call here is a round trip to a hosted database.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

interface InvoiceView {
  id: string;
  amountPaid: number;
  outstanding: number;
  amendsInvoiceId: string | null;
  amendedByInvoiceId: string | null;
  creditNotes: { id: string; status: string }[];
  lines: { id: string }[];
  payments: { kind: string; amount: number }[];
}

async function seriesFor(t: TenantFixture, size = 60): Promise<InvoiceSeries> {
  const s = await createSeries(t, { prefix: 'R2' });
  let seq = (await leaseBlock(t, s.id, size)).startSeq;
  return { seriesId: s.id, next: () => seq++ };
}

async function creditSeries(t: TenantFixture, size = 30): Promise<InvoiceSeries> {
  const s = await createSeries(t, { prefix: 'CN', documentType: 'credit_note' });
  let seq = (await leaseBlock(t, s.id, size)).startSeq;
  return { seriesId: s.id, next: () => seq++ };
}

async function raiseInvoice(
  t: TenantFixture,
  series: InvoiceSeries,
  order: OrderView,
  quantities: number[],
  extra: Record<string, unknown> = {},
) {
  const res = await t
    .post('/v1/invoices')
    .send(orderInvoiceRequest(t, series, order, quantities, extra))
    .expect(201);
  return res;
}

async function creditEverything(
  t: TenantFixture,
  credits: InvoiceSeries,
  invoice: InvoiceView,
  quantityPerLine: number[],
  refundMode = 'khata',
) {
  return t.post('/v1/credit-notes').send({
    id: randomUUID(),
    originalInvoiceId: invoice.id,
    seriesId: credits.seriesId,
    sequenceNo: credits.next(),
    documentDate: today(),
    issuedAt: new Date().toISOString(),
    lines: invoice.lines.map((l, i) => ({
      id: randomUUID(),
      invoiceLineId: l.id,
      quantity: quantityPerLine[i] ?? 0,
    })),
    reasonCode: 'return',
    refundMode,
  });
}

const customerBalance = async (t: TenantFixture, id: string) =>
  data<{ balance: number }>(await t.get(`/v1/customers/${id}`).expect(200)).balance;

afterAll(async () => {
  await closeOwnerClient();
  await closePool();
});

describe('plan gating and roles', () => {
  let t: TenantFixture;
  let itemId: string;

  beforeAll(async () => {
    t = await createTenant({ name: 'Gate Shop' });
    itemId = (await createItem(t)).id;
  });

  it('a plan without sales orders is refused, including fulfilling one', async () => {
    const series = await seriesFor(t, 10);
    const order = await createOrder(t, [orderLine({ itemId, quantity: 1000, unitPrice: 10_000 })], {
      customerId: (await createCustomer(t)).id,
    });

    await setPlan(t, 'lite', { offline_mode: true, credit_notes: true });
    expect(error(await t.get('/v1/sales-orders').expect(402)).code).toBe('FEATURE_NOT_IN_PLAN');
    expect(error(await t.get(`/v1/sales-orders/${order.id}`).expect(402)).code).toBe(
      'FEATURE_NOT_IN_PLAN',
    );
    await t
      .post('/v1/sales-orders')
      .send({ id: randomUUID(), ...orderBody(t, [orderLine({ itemId, quantity: 1000, unitPrice: 10_000 })]) })
      .expect(402);
    // An order the business already holds still cannot be fulfilled on this plan.
    const blocked = await t
      .post('/v1/invoices')
      .send(orderInvoiceRequest(t, series, order, [1000]))
      .expect(402);
    expect(error(blocked).code).toBe('FEATURE_NOT_IN_PLAN');

    // Everything else on Lite still works.
    await t
      .post('/v1/invoices')
      .send(
        invoicePayload(t, {
          seriesId: series.seriesId,
          sequenceNo: series.next(),
          lines: [{ itemId, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
          payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
        }),
      )
      .expect(201);

    await setPlan(t, 'standard', { offline_mode: true, sales_orders: true });
    await t.get('/v1/sales-orders').expect(200);
    await setPlan(t, 'trial', { '*': true });
  });

  it('the migration granted sales orders to Standard shops that predate it', async () => {
    // Only the grant itself is checked here: a row written the way onboarding writes it.
    const c = await ownerClient();
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscriptions
       WHERE plan = 'standard' AND NOT (features ? 'sales_orders')`,
    );
    expect(r.rows[0]?.n).toBe(0);
  });

  it('only the owner edits or deletes an order; a manager can cancel and close', async () => {
    const manager = await addMember(t, 'manager');
    const cashier = await addMember(t, 'cashier');
    const mk = () => createOrder(t, [orderLine({ itemId, quantity: 1000, unitPrice: 10_000 })]);
    const o1 = await mk();
    const edit = {
      ...orderBody(t, [orderLine({ id: o1.lines[0]?.id, itemId, quantity: 1000, unitPrice: 10_000 })]),
    };

    await manager.put(`/v1/sales-orders/${o1.id}`).send(edit).expect(403);
    await manager.del(`/v1/sales-orders/${o1.id}`).expect(403);
    await t.put(`/v1/sales-orders/${o1.id}`).send(edit).expect(200);

    const o2 = await mk();
    await manager.post(`/v1/sales-orders/${o2.id}/cancel`).send({ reason: 'customer left' }).expect(200);
    const o3 = await mk();
    await manager.post(`/v1/sales-orders/${o3.id}/close`).send({}).expect(200);

    // A cashier takes and reads orders, and nothing that changes or reverses one.
    const o4 = await mk();
    await cashier
      .post('/v1/sales-orders')
      .send({ id: randomUUID(), ...orderBody(t, [orderLine({ itemId, quantity: 1000, unitPrice: 10_000 })]) })
      .expect(201);
    await cashier.get(`/v1/sales-orders/${o4.id}`).expect(200);
    await cashier.put(`/v1/sales-orders/${o4.id}`).send(edit).expect(403);
    await cashier.del(`/v1/sales-orders/${o4.id}`).expect(403);
    await cashier.post(`/v1/sales-orders/${o4.id}/cancel`).send({ reason: 'x' }).expect(403);
    await cashier.post(`/v1/sales-orders/${o4.id}/close`).send({}).expect(403);

    await t.del(`/v1/sales-orders/${o4.id}`).expect(204);
  });
});

describe('stock reservation', () => {
  let t: TenantFixture;
  let series: InvoiceSeries;

  beforeAll(async () => {
    t = await createTenant({ name: 'Reserve Shop' });
    series = await seriesFor(t);
    await setAllowNegativeStock(t, true);
  });

  it('reserves on create, follows edits, converts on invoicing, and releases on close', async () => {
    const item = await createItem(t);
    await stockIn(t, item.id, 10_000);
    const customer = await createCustomer(t);

    const order = await createOrder(t, [orderLine({ itemId: item.id, quantity: 4000, unitPrice: 10_000 })], {
      customerId: customer.id,
    });
    expect(await balanceOf(t, item.id)).toMatchObject({ quantity: 10_000, reserved: 4000, available: 6000 });

    // An edit moves the reservation by the difference.
    await t
      .put(`/v1/sales-orders/${order.id}`)
      .send(
        orderBody(t, [orderLine({ id: order.lines[0]?.id, itemId: item.id, quantity: 6000, unitPrice: 10_000 })], {
          customerId: customer.id,
        }),
      )
      .expect(200);
    expect(await balanceOf(t, item.id)).toMatchObject({ quantity: 10_000, reserved: 6000, available: 4000 });

    // The invoice takes stock off the shelf and takes the same amount off the reservation,
    // so what is available does not move.
    const current = await getOrder(t, order.id);
    await raiseInvoice(t, series, current, [2000]);
    expect(await balanceOf(t, item.id)).toMatchObject({ quantity: 8000, reserved: 4000, available: 4000 });

    // Closing stops reserving what will not be delivered.
    await t.post(`/v1/sales-orders/${order.id}/close`).send({}).expect(200);
    expect(await balanceOf(t, item.id)).toMatchObject({ quantity: 8000, reserved: 0, available: 8000 });
  });

  it('releases on cancel and on delete, and voiding the invoice reserves again', async () => {
    const item = await createItem(t);
    await stockIn(t, item.id, 10_000);
    const a = await createOrder(t, [orderLine({ itemId: item.id, quantity: 3000, unitPrice: 10_000 })]);
    const b = await createOrder(t, [orderLine({ itemId: item.id, quantity: 2000, unitPrice: 10_000 })]);
    expect((await balanceOf(t, item.id)).reserved).toBe(5000);

    await t.post(`/v1/sales-orders/${a.id}/cancel`).send({ reason: 'changed mind' }).expect(200);
    expect((await balanceOf(t, item.id)).reserved).toBe(2000);
    await t.del(`/v1/sales-orders/${b.id}`).expect(204);
    expect((await balanceOf(t, item.id)).reserved).toBe(0);

    const customer = await createCustomer(t);
    const c = await createOrder(t, [orderLine({ itemId: item.id, quantity: 2000, unitPrice: 10_000 })], {
      customerId: customer.id,
    });
    const inv = data<InvoiceView>(await raiseInvoice(t, series, c, [2000]));
    expect(await balanceOf(t, item.id)).toMatchObject({ quantity: 8000, reserved: 0 });
    await t.post(`/v1/invoices/${inv.id}/void`).send({ reason: 'wrong bill' }).expect(200);
    expect(await balanceOf(t, item.id)).toMatchObject({ quantity: 10_000, reserved: 2000 });
  });

  it('a custom line reserves nothing', async () => {
    const item = await createItem(t);
    await stockIn(t, item.id, 5000);
    await createOrder(t, [
      orderLine({ itemId: item.id, quantity: 1000, unitPrice: 10_000 }),
      orderLine({ itemName: 'Gift wrapping', unit: 'job', quantity: 5000, unitPrice: 2000 }),
    ]);
    expect((await balanceOf(t, item.id)).reserved).toBe(1000);
  });

  it('warns on a shortfall when negative stock is allowed, and refuses when it is not', async () => {
    const item = await createItem(t);
    await stockIn(t, item.id, 5000);
    const body = orderBody(t, [orderLine({ itemId: item.id, quantity: 8000, unitPrice: 10_000 })]);

    await setAllowNegativeStock(t, false);
    const refused = await t.post('/v1/sales-orders').send({ id: randomUUID(), ...body }).expect(422);
    expect(error(refused).code).toBe('INSUFFICIENT_STOCK');
    expect((await balanceOf(t, item.id)).reserved).toBe(0);

    await setAllowNegativeStock(t, true);
    const created = await t.post('/v1/sales-orders').send({ id: randomUUID(), ...body }).expect(201);
    const warnings = (created.body as { warnings: { code: string }[] }).warnings;
    expect(warnings.map((w) => w.code)).toContain('RESERVATION_SHORTFALL');
    expect(await balanceOf(t, item.id)).toMatchObject({ quantity: 5000, reserved: 8000, available: -3000 });

    // A walk-in sale that takes stock an order is waiting for is warned about, not stopped.
    const sale = await t
      .post('/v1/invoices')
      .send(
        invoicePayload(t, {
          seriesId: series.seriesId,
          sequenceNo: series.next(),
          lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
          payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
        }),
      )
      .expect(201);
    expect(
      (sale.body as { warnings: { code: string }[] }).warnings.map((w) => w.code),
    ).toContain('RESERVED_STOCK');
  });

  it('an adjustment cannot write off stock that is promised, unless negative stock is allowed', async () => {
    const item = await createItem(t);
    await stockIn(t, item.id, 5000);
    await createOrder(t, [orderLine({ itemId: item.id, quantity: 4000, unitPrice: 10_000 })]);

    await setAllowNegativeStock(t, false);
    const writeOff = (delta: number) =>
      t.post('/v1/stock/adjustments').send({
        id: randomUUID(),
        outletId: t.outletId,
        itemId: item.id,
        quantityDelta: delta,
        reasonCode: 'damage',
        occurredAt: new Date().toISOString(),
      });
    expect(error(await writeOff(-2000).expect(422)).code).toBe('INSUFFICIENT_STOCK');
    await writeOff(-1000).expect(201);
    await setAllowNegativeStock(t, true);
  });

  it('the reserved column matches the open orders, and a drift can be found and repaired', async () => {
    const clean = data<{ drift: unknown[] }>(
      await t.post('/v1/stock/reservations/reconcile').send({}).expect(200),
    );
    expect(clean.drift).toEqual([]);

    const item = await createItem(t);
    await stockIn(t, item.id, 5000);
    await createOrder(t, [orderLine({ itemId: item.id, quantity: 1000, unitPrice: 10_000 })]);
    const c = await ownerClient();
    await c.query('UPDATE stock_balances SET reserved = reserved + 7 WHERE item_id = $1', [item.id]);

    const found = data<{ drift: { itemId: string; expected: number; stored: number }[] }>(
      await t.post('/v1/stock/reservations/reconcile').send({}).expect(200),
    );
    expect(found.drift.find((d) => d.itemId === item.id)).toMatchObject({ expected: 1000, stored: 1007 });

    const repaired = data<{ repaired: boolean }>(
      await t.post('/v1/stock/reservations/reconcile').send({ repair: true }).expect(200),
    );
    expect(repaired.repaired).toBe(true);
    const after = data<{ drift: unknown[] }>(
      await t.post('/v1/stock/reservations/reconcile').send({}).expect(200),
    );
    expect(after.drift).toEqual([]);
  });

  it('low stock is measured on what can still be sold', async () => {
    const item = await createItem(t);
    await t.patch(`/v1/items/${item.id}`).send({ reorderLevel: 3000 }).expect(200);
    await stockIn(t, item.id, 5000);
    const below = async () =>
      rows<{ itemId: string }>(
        await t.get(`/v1/stock/balances?outletId=${t.outletId}&belowReorder=true`).expect(200),
      ).some((r) => r.itemId === item.id);
    expect(await below()).toBe(false);
    await createOrder(t, [orderLine({ itemId: item.id, quantity: 3000, unitPrice: 10_000 })]);
    expect(await below()).toBe(true);
  });
});

describe('advance: applied to invoices, and refunded', () => {
  let t: TenantFixture;
  let series: InvoiceSeries;
  let itemId: string;

  beforeAll(async () => {
    t = await createTenant({ name: 'Advance Shop' });
    series = await seriesFor(t);
    itemId = (await createItem(t)).id;
  });

  const lineSpec = () => [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })];

  it('counts the advance toward the invoice, gives it back on a void, and locks it once used', async () => {
    const customer = await createCustomer(t);
    const order = await createOrder(t, lineSpec(), {
      customerId: customer.id,
      advanceAmount: 10_000,
      paymentMode: 'cash',
    });

    const invoice = data<InvoiceView>(await raiseInvoice(t, series, order, [2000]));
    expect(invoice.amountPaid).toBe(10_000);
    expect(invoice.outstanding).toBe(13_600);
    expect(invoice.payments.map((p) => p.kind)).toContain('order_advance');
    let state = await getOrder(t, order.id);
    expect(state).toMatchObject({ status: 'closed', advanceApplied: 10_000, advanceRemaining: 0 });
    // The khata already netted the advance: total owed is the unpaid part only.
    expect(await customerBalance(t, customer.id)).toBe(13_600);

    const edit = orderBody(
      t,
      [orderLine({ id: state.lines[0]?.id, itemId, quantity: 2000, unitPrice: 10_000 })],
      { customerId: customer.id, advanceAmount: 12_000, paymentMode: 'cash' },
    );
    expect(error(await t.put(`/v1/sales-orders/${order.id}`).send(edit).expect(422)).code).toBe(
      'ADVANCE_LOCKED',
    );

    await t.post(`/v1/invoices/${invoice.id}/void`).send({ reason: 'wrong bill' }).expect(200);
    state = await getOrder(t, order.id);
    expect(state).toMatchObject({ status: 'open', advanceApplied: 0, advanceRemaining: 10_000 });
    expect(await customerBalance(t, customer.id)).toBe(-10_000);
  });

  it('cancelling pays the unused advance back the way it was taken', async () => {
    const customer = await createCustomer(t);
    const order = await createOrder(t, lineSpec(), {
      customerId: customer.id,
      advanceAmount: 10_000,
      paymentMode: 'cash',
    });
    expect(await customerBalance(t, customer.id)).toBe(-10_000);

    const res = await t
      .post(`/v1/sales-orders/${order.id}/cancel`)
      .send({ reason: 'customer left' })
      .expect(200);
    const body = res.body as { data: OrderView; refund: { amount: number; mode: string; paidOut: boolean } };
    expect(body.refund).toEqual({ amount: 10_000, mode: 'cash', paidOut: true });
    expect(body.data).toMatchObject({ status: 'cancelled', advanceRefunded: 10_000, advanceRemaining: 0 });
    expect(await customerBalance(t, customer.id)).toBe(0);

    // Cancelling again is a replay: nothing is paid twice.
    const again = await t.post(`/v1/sales-orders/${order.id}/cancel`).send({ reason: 'x' }).expect(200);
    expect((again.body as { refund: unknown }).refund).toBeNull();
    expect(await customerBalance(t, customer.id)).toBe(0);
  });

  it('can refund by another mode, or leave the advance as the customer’s credit', async () => {
    const customer = await createCustomer(t);
    const upi = await createOrder(t, lineSpec(), {
      customerId: customer.id,
      advanceAmount: 5000,
      paymentMode: 'cash',
    });
    const r1 = await t
      .post(`/v1/sales-orders/${upi.id}/cancel`)
      .send({ reason: 'x', refundMode: 'upi' })
      .expect(200);
    expect((r1.body as { refund: { mode: string } }).refund.mode).toBe('upi');
    expect(await customerBalance(t, customer.id)).toBe(0);

    const credit = await createOrder(t, lineSpec(), {
      customerId: customer.id,
      advanceAmount: 4000,
      paymentMode: 'cash',
    });
    const r2 = await t
      .post(`/v1/sales-orders/${credit.id}/cancel`)
      .send({ reason: 'x', refundMode: 'khata' })
      .expect(200);
    expect((r2.body as { refund: { paidOut: boolean } }).refund.paidOut).toBe(false);
    expect(await customerBalance(t, customer.id)).toBe(-4000);
  });

  it('deleting refunds an unused advance instead of un-recording it; closing keeps it as credit', async () => {
    const customer = await createCustomer(t);
    const doomed = await createOrder(t, lineSpec(), {
      customerId: customer.id,
      advanceAmount: 3000,
      paymentMode: 'cash',
    });
    const del = await t.del(`/v1/sales-orders/${doomed.id}`).expect(200);
    expect((del.body as { data: { refund: { paidOut: boolean } } }).data.refund.paidOut).toBe(true);
    await t.get(`/v1/sales-orders/${doomed.id}`).expect(404);
    expect(await customerBalance(t, customer.id)).toBe(0);

    const closing = await createOrder(t, lineSpec(), {
      customerId: customer.id,
      advanceAmount: 2000,
      paymentMode: 'cash',
    });
    const kept = await t.post(`/v1/sales-orders/${closing.id}/close`).send({}).expect(200);
    expect((kept.body as { refund: { mode: string } }).refund.mode).toBe('khata');
    expect(await customerBalance(t, customer.id)).toBe(-2000);

    const paid = await createOrder(t, lineSpec(), {
      customerId: customer.id,
      advanceAmount: 1500,
      paymentMode: 'cash',
    });
    const out = await t
      .post(`/v1/sales-orders/${paid.id}/close`)
      .send({ refundMode: 'cash' })
      .expect(200);
    expect((out.body as { refund: { paidOut: boolean } }).refund.paidOut).toBe(true);
    expect(await customerBalance(t, customer.id)).toBe(-2000);
  });

  it('a cash advance raises the drawer and its refund lowers it', async () => {
    const shop = await createTenant({ name: 'Drawer Shop' });
    const item = await createItem(shop);
    const customer = await createCustomer(shop);
    const expected = async () =>
      data<{ expectedCash: number; cashReceipts: number; cashRefunds: number }>(
        await shop.get(`/v1/day-close/expected?outletId=${shop.outletId}`).expect(200),
      );
    expect((await expected()).expectedCash).toBe(0);

    const order = await createOrder(
      shop,
      [orderLine({ itemId: item.id, quantity: 2000, unitPrice: 10_000 })],
      { customerId: customer.id, advanceAmount: 10_000, paymentMode: 'cash' },
    );
    expect(await expected()).toMatchObject({ expectedCash: 10_000, cashReceipts: 10_000, cashRefunds: 0 });

    await shop.post(`/v1/sales-orders/${order.id}/cancel`).send({ reason: 'x' }).expect(200);
    expect(await expected()).toMatchObject({ expectedCash: 0, cashReceipts: 10_000, cashRefunds: 10_000 });
  });
});

describe('editing after invoicing', () => {
  let t: TenantFixture;
  let series: InvoiceSeries;
  let credits: InvoiceSeries;
  let itemId: string;
  let customerId: string;

  beforeAll(async () => {
    t = await createTenant({ name: 'Edit Shop' });
    series = await seriesFor(t);
    credits = await creditSeries(t);
    itemId = (await createItem(t)).id;
    customerId = (await createCustomer(t)).id;
  });

  it('a closed order can be edited, and adding something to deliver re-opens it', async () => {
    const order = await createOrder(t, [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })], {
      customerId,
    });
    await raiseInvoice(t, series, order, [2000]);
    let state = await getOrder(t, order.id);
    expect(state.status).toBe('closed');
    const first = orderLine({ id: state.lines[0]?.id, itemId, quantity: 2000, unitPrice: 10_000 });

    // Notes only: stays closed.
    await t
      .put(`/v1/sales-orders/${order.id}`)
      .send(orderBody(t, [first], { customerId, notes: 'Delivered to the side gate' }))
      .expect(200);
    expect((await getOrder(t, order.id)).status).toBe('closed');

    // A new line: there is something to deliver again.
    await t
      .put(`/v1/sales-orders/${order.id}`)
      .send(
        orderBody(t, [first, orderLine({ itemId, quantity: 1000, unitPrice: 10_000 })], { customerId }),
      )
      .expect(200);
    state = await getOrder(t, order.id);
    expect(state.status).toBe('partial');
  });

  it('the price, tax and discount of an invoiced line are fixed; its quantity can grow', async () => {
    const order = await createOrder(t, [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })], {
      customerId,
    });
    await raiseInvoice(t, series, order, [1000]);
    const state = await getOrder(t, order.id);
    const lineId = state.lines[0]?.id;

    const reprice = await t
      .put(`/v1/sales-orders/${order.id}`)
      .send(orderBody(t, [orderLine({ id: lineId, itemId, quantity: 2000, unitPrice: 12_000 })], { customerId }))
      .expect(422);
    expect(error(reprice).code).toBe('ORDER_LINE_INVOICED');

    await t
      .put(`/v1/sales-orders/${order.id}`)
      .send(orderBody(t, [orderLine({ id: lineId, itemId, quantity: 3000, unitPrice: 10_000 })], { customerId }))
      .expect(200);
    expect((await getOrder(t, order.id)).lines[0]?.quantity).toBe(3000);
  });

  it('a manually closed order stays closed through a notes edit but re-opens when quantity grows', async () => {
    const order = await createOrder(t, [orderLine({ itemId, quantity: 3000, unitPrice: 10_000 })], {
      customerId,
    });
    await t.post(`/v1/sales-orders/${order.id}/close`).send({}).expect(200);
    const lineId = (await getOrder(t, order.id)).lines[0]?.id;
    const edit = (quantity: number, notes: string) =>
      t
        .put(`/v1/sales-orders/${order.id}`)
        .send(orderBody(t, [orderLine({ id: lineId, itemId, quantity, unitPrice: 10_000 })], { customerId, notes }))
        .expect(200);

    await edit(3000, 'note only');
    expect((await getOrder(t, order.id)).status).toBe('closed');
    await edit(5000, 'five now');
    expect((await getOrder(t, order.id)).status).toBe('open');
  });

  it('a return re-opens the order for what came back, and voiding the return closes it again', async () => {
    const order = await createOrder(t, [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })], {
      customerId,
    });
    const invoice = data<InvoiceView>(await raiseInvoice(t, series, order, [2000]));
    expect((await getOrder(t, order.id)).status).toBe('closed');

    const cnRes = await creditEverything(t, credits, invoice, [2000]);
    expect(cnRes.status).toBe(201);
    const cn = data<{ id: string }>(cnRes);
    let state = await getOrder(t, order.id);
    expect(state.status).toBe('open');
    expect(state.lines[0]?.quantityFulfilled).toBe(0);

    await t.post(`/v1/credit-notes/${cn.id}/void`).send({ reason: 'taken back by mistake' }).expect(200);
    state = await getOrder(t, order.id);
    expect(state.status).toBe('closed');
    expect(state.lines[0]?.quantityFulfilled).toBe(2000);
  });
});

describe('invoice amendment', () => {
  let t: TenantFixture;
  let series: InvoiceSeries;
  let credits: InvoiceSeries;
  let item: { id: string };
  let customerId: string;

  beforeAll(async () => {
    t = await createTenant({ name: 'Amend Shop' });
    series = await seriesFor(t);
    credits = await creditSeries(t);
    item = await createItem(t);
    customerId = (await createCustomer(t)).id;
    await stockIn(t, item.id, 10_000);
  });

  const replacement = (
    order: OrderView,
    original: InvoiceView,
    unitPrice: number,
    extra: Record<string, unknown> = {},
  ) => {
    const lines = [
      {
        id: randomUUID(),
        itemId: item.id,
        quantity: 2000,
        unitPrice,
        taxRatePercent: 18,
        salesOrderLineId: order.lines[0]?.id,
      },
    ];
    return {
      ...invoicePayload(t, {
        seriesId: series.seriesId,
        sequenceNo: series.next(),
        customerId,
        lines: [{ itemId: item.id, quantity: 2000, unitPrice, taxRatePercent: 18 }],
      }),
      salesOrderId: order.id,
      amendsInvoiceId: original.id,
      lines,
      expectedTotals: expectedTotals([{ itemId: item.id, quantity: 2000, unitPrice, taxRatePercent: 18 }]),
      ...extra,
    };
  };

  it('replaces a fully credited invoice with a linked one, keeps stock level and re-applies the order', async () => {
    const order = await createOrder(t, [orderLine({ itemId: item.id, quantity: 2000, unitPrice: 10_000 })], {
      customerId,
    });
    const original = data<InvoiceView>(await raiseInvoice(t, series, order, [2000]));
    expect((await balanceOf(t, item.id)).quantity).toBe(8000);

    // Not until the whole invoice has been credited.
    const early = await t.post('/v1/invoices').send(replacement(order, original, 12_000)).expect(422);
    expect(error(early).code).toBe('AMENDMENT_NOT_ALLOWED');

    // A partial credit is not enough either.
    const partial = await creditEverything(t, credits, original, [1000]);
    expect(partial.status).toBe(201);
    const stillPartial = await t.post('/v1/invoices').send(replacement(await getOrder(t, order.id), original, 12_000));
    expect(stillPartial.status).toBe(422);

    // Credit the rest.
    await creditEverything(t, credits, original, [1000]).then((r) => expect(r.status).toBe(201));
    expect((await balanceOf(t, item.id)).quantity).toBe(10_000);
    expect((await getOrder(t, order.id)).status).toBe('open');

    // The original cannot be voided as well: its return already reversed it.
    const voidIt = await t.post(`/v1/invoices/${original.id}/void`).send({ reason: 'x' }).expect(422);
    expect(error(voidIt).code).toBe('INVOICE_HAS_CREDIT_NOTES');

    const reissued = data<InvoiceView>(
      await t
        .post('/v1/invoices')
        .send(replacement(await getOrder(t, order.id), original, 12_000))
        .expect(201),
    );
    expect(reissued.amendsInvoiceId).toBe(original.id);
    expect((await balanceOf(t, item.id)).quantity).toBe(8000);
    expect((await getOrder(t, order.id)).status).toBe('closed');

    const old = data<InvoiceView>(await t.get(`/v1/invoices/${original.id}`).expect(200));
    expect(old.amendedByInvoiceId).toBe(reissued.id);
    expect(old.creditNotes).toHaveLength(2);

    // Only once.
    const twice = await t
      .post('/v1/invoices')
      .send(replacement(await getOrder(t, order.id), original, 13_000))
      .expect(422);
    expect(error(twice).code).toBe('AMENDMENT_NOT_ALLOWED');
  });

  it('a replaced invoice hands its advance to the replacement', async () => {
    const order = await createOrder(t, [orderLine({ itemId: item.id, quantity: 2000, unitPrice: 10_000 })], {
      customerId,
      advanceAmount: 10_000,
      paymentMode: 'upi',
    });
    const original = data<InvoiceView>(await raiseInvoice(t, series, order, [2000]));
    expect(original.amountPaid).toBe(10_000);
    await creditEverything(t, credits, original, [2000]).then((r) => expect(r.status).toBe(201));

    const reissued = data<InvoiceView>(
      await t
        .post('/v1/invoices')
        .send(replacement(await getOrder(t, order.id), original, 10_000))
        .expect(201),
    );
    expect(reissued.amountPaid).toBe(10_000);
    expect(await getOrder(t, order.id)).toMatchObject({ advanceApplied: 10_000, advanceRemaining: 0 });
  });
});

describe('custom items and discounts', () => {
  let t: TenantFixture;
  let series: InvoiceSeries;
  let itemId: string;
  let customerId: string;

  beforeAll(async () => {
    t = await createTenant({ name: 'Discount Shop' });
    series = await seriesFor(t);
    itemId = (await createItem(t)).id;
    customerId = (await createCustomer(t)).id;
  });

  it('a custom line is invoiced from the order, and cannot be over-invoiced', async () => {
    const order = await createOrder(t, [
      orderLine({ itemId, quantity: 1000, unitPrice: 10_000 }),
      orderLine({ itemName: 'Delivery', unit: 'job', quantity: 1000, unitPrice: 10_000 }),
    ], { customerId });
    expect(order.lines[1]?.itemId).toBeNull();

    const over = await t
      .post('/v1/invoices')
      .send(orderInvoiceRequest(t, series, order, [1000, 2000]))
      .expect(422);
    expect(error(over).code).toBe('FULFILMENT_EXCEEDS_ORDER');

    const res = await raiseInvoice(t, series, order, [1000, 1000]);
    const lines = data<{ lines: { itemName: string; itemId: string | null }[] }>(res).lines;
    expect(lines.some((l) => l.itemId === null && l.itemName === 'Custom item')).toBe(true);
    expect((await getOrder(t, order.id)).status).toBe('closed');
  });

  it('takes a bill discount with a reason, and rejects one larger than the bill', async () => {
    const lines = [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })];
    // 20,000 gross - 10% = 18,000 taxable; 18% = 3,240.
    const order = await createOrder(
      t,
      lines,
      { billDiscount: { kind: 'percent', value: 10 }, billDiscountReason: 'Festival offer' },
      { taxableAmount: 18_000, totalTax: 3240, grandTotal: 21_240 },
    );
    expect(order).toMatchObject({ grandTotal: 21_240, billDiscountAmount: 2000, billDiscountRemaining: 2000 });

    const tooBig = await t
      .post('/v1/sales-orders')
      .send({
        id: randomUUID(),
        ...orderBody(t, lines, { billDiscount: { kind: 'amount', value: 50_000 } }, {
          taxableAmount: 0,
          totalTax: 0,
          grandTotal: 0,
        }),
      })
      .expect(400);
    expect((error(tooBig).details as { code?: string }).code).toBe('DISCOUNT_EXCEEDS_TOTAL');
  });

  it('refuses a discount over the shop’s limit unless an approver stands behind it', async () => {
    await t.put('/v1/discount-policies').send({ maxBillDiscountPercent: 5 }).expect(200);
    const lines = [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })];
    const totals = { taxableAmount: 18_000, totalTax: 3240, grandTotal: 21_240 };
    const discount = { billDiscount: { kind: 'percent' as const, value: 10 } };

    const refused = await t
      .post('/v1/sales-orders')
      .send({ id: randomUUID(), ...orderBody(t, lines, discount, totals) })
      .expect(422);
    expect(error(refused).code).toBe('DISCOUNT_CAP_EXCEEDED');

    const approval = (approvedBy: string) => ({
      discountApprovals: [
        {
          id: randomUUID(),
          breachKind: 'bill_discount_percent',
          requestedValue: 10,
          allowedValue: 5,
          approvedBy,
          approvedAt: new Date().toISOString(),
        },
      ],
    });
    const cashier = await addMember(t, 'cashier');
    const bad = await t
      .post('/v1/sales-orders')
      .send({ id: randomUUID(), ...orderBody(t, lines, { ...discount, ...approval(cashier.userId) }, totals) })
      .expect(422);
    expect(error(bad).code).toBe('APPROVER_NOT_PERMITTED');

    const ok = await t
      .post('/v1/sales-orders')
      .send({ id: randomUUID(), ...orderBody(t, lines, { ...discount, ...approval(t.userId) }, totals) })
      .expect(201);
    expect(data<OrderView>(ok).billDiscountAmount).toBe(2000);

    // What was approved on the order is not asked about again on its invoice.
    const order = data<OrderView>(ok);
    const inv = await t
      .post('/v1/invoices')
      .send({
        ...orderInvoiceRequest(t, series, order, [2000]),
        billDiscount: { kind: 'percent', value: 10 },
        expectedTotals: totals,
        // A walk-in bill is paid at the counter.
        payments: [{ id: randomUUID(), mode: 'cash', amount: totals.grandTotal }],
      })
      .expect(201);
    expect(
      (inv.body as { warnings: { code: string }[] }).warnings.map((w) => w.code),
    ).not.toContain('DISCOUNT_CAP_EXCEEDED');
    await t.put('/v1/discount-policies').send({ maxBillDiscountPercent: null }).expect(200);
  });

  it('a flat bill discount is carried across invoices until none is left', async () => {
    const lines = [
      orderLine({ itemId, quantity: 1000, unitPrice: 10_000 }),
      orderLine({ itemId, quantity: 1000, unitPrice: 10_000 }),
    ];
    // 20,000 gross - 2,000 = 18,000 taxable; 18% = 3,240.
    const order = await createOrder(
      t,
      lines,
      { customerId, billDiscount: { kind: 'amount', value: 2000 } },
      { taxableAmount: 18_000, totalTax: 3240, grandTotal: 21_240 },
    );
    expect(order.billDiscountRemaining).toBe(2000);

    const half = (index: number) => {
      const base = orderInvoiceRequest(t, series, order, index === 0 ? [1000, 0] : [0, 1000]);
      // 10,000 - 1,000 = 9,000 taxable; 18% = 1,620.
      return {
        ...base,
        billDiscount: { kind: 'amount', value: 1000 },
        expectedTotals: { taxableAmount: 9000, totalTax: 1620, grandTotal: 10_620 },
      };
    };
    await t.post('/v1/invoices').send(half(0)).expect(201);
    expect((await getOrder(t, order.id)).billDiscountRemaining).toBe(1000);
    await t.post('/v1/invoices').send(half(1)).expect(201);
    expect((await getOrder(t, order.id)).billDiscountRemaining).toBe(0);
  });
});

describe('parity with invoices', () => {
  let t: TenantFixture;
  let itemId: string;

  beforeAll(async () => {
    t = await createTenant({ name: 'Parity Shop' });
    itemId = (await createItem(t)).id;
  });

  it('supports reverse charge and additional charges', async () => {
    // A line id belongs to one order for ever, so each order gets its own lines.
    const lines = () => [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })];
    // Reverse charge: the value is reported but the order carries no tax.
    const rc = await createOrder(t, lines(), { isReverseCharge: true }, {
      taxableAmount: 20_000,
      totalTax: 0,
      grandTotal: 20_000,
    });
    expect(rc.grandTotal).toBe(20_000);

    const charged = await createOrder(
      t,
      lines(),
      { additionalCharges: [{ id: 'freight', label: 'Freight', amount: 1000, taxable: false }] },
      { taxableAmount: 20_000, totalTax: 3600, grandTotal: 24_600 },
    );
    expect(charged.grandTotal).toBe(24_600);
  });

  it('can be searched by number, customer or phone', async () => {
    const lines = [orderLine({ itemId, quantity: 1000, unitPrice: 10_000 })];
    const order = await createOrder(t, lines, { customerName: 'Zaheer Traders', customerPhone: '919812345678' });
    const find = async (q: string) =>
      rows<{ id: string }>(await t.get(`/v1/sales-orders?q=${encodeURIComponent(q)}`).expect(200)).map(
        (r) => r.id,
      );
    expect(await find('Zaheer')).toContain(order.id);
    expect(await find('9812345')).toContain(order.id);
    expect(await find(order.documentNumber)).toContain(order.id);
    expect(await find('no-such-customer-xyz')).not.toContain(order.id);
  });

  it('shows open orders, advances and what is pending in the status report', async () => {
    const shop = await createTenant({ name: 'Report Shop' });
    const item = await createItem(shop);
    const customer = await createCustomer(shop);
    const open = await createOrder(
      shop,
      [orderLine({ itemId: item.id, quantity: 2000, unitPrice: 10_000 })],
      { customerId: customer.id, advanceAmount: 5000, paymentMode: 'cash' },
    );
    const cancelled = await createOrder(shop, [
      orderLine({ itemId: item.id, quantity: 1000, unitPrice: 10_000 }),
    ]);
    await shop.post(`/v1/sales-orders/${cancelled.id}/cancel`).send({ reason: 'x' }).expect(200);

    const res = await shop.get('/v1/reports/sale-order-status').expect(200);
    const report = data<{ rows: Record<string, unknown>[] }>(res);
    const row = report.rows.find((r) => r['orderNumber'] === open.documentNumber);
    expect(row).toMatchObject({
      status: 'open',
      orderValue: 23_600,
      advancePaid: 5000,
      balanceDue: 18_600,
      pendingQuantity: 2000,
    });
    // A cancelled order is not owed to anyone.
    expect(report.rows.some((r) => r['orderNumber'] === cancelled.documentNumber)).toBe(false);
  });

  it('searches purchase orders and bills the same way', async () => {
    const supplierId = randomUUID();
    await t.post('/v1/suppliers').send({ id: supplierId, name: 'Quicksilver Wholesale' }).expect(201);
    const poId = randomUUID();
    await t
      .post('/v1/purchase-orders')
      .send({
        id: poId,
        outletId: t.outletId,
        supplierId,
        documentDate: today(),
        lines: [{ id: randomUUID(), itemId, quantityOrdered: 1000, expectedUnitCost: 5000 }],
      })
      .expect(201);
    const billId = randomUUID();
    await t
      .post('/v1/purchase-bills')
      .send({
        id: billId,
        outletId: t.outletId,
        supplierId,
        documentDate: today(),
        supplierInvoiceNo: 'QS-90210',
        supplierInvoiceDate: today(),
        receivedAt: new Date().toISOString(),
        lines: [{ id: randomUUID(), itemId, quantity: 1000, unitPrice: 5000, taxRatePercent: 18 }],
      })
      .expect(201);

    const ids = async (path: string, q: string) =>
      rows<{ id: string }>(await t.get(`${path}?q=${encodeURIComponent(q)}`).expect(200)).map((r) => r.id);
    expect(await ids('/v1/purchase-orders', 'Quicksilver')).toContain(poId);
    expect(await ids('/v1/purchase-orders', 'nobody-by-this-name')).not.toContain(poId);
    expect(await ids('/v1/purchase-bills', 'QS-902')).toContain(billId);
    expect(await ids('/v1/purchase-bills', 'Quicksilver')).toContain(billId);
    expect(await ids('/v1/purchase-bills', 'nobody-by-this-name')).not.toContain(billId);
  });

  it('prints as a sale order, with the advance and the balance, never as a tax invoice', async () => {
    const shop = await createTenant({ name: 'Print Shop' });
    const item = await createItem(shop);
    const customer = await createCustomer(shop);
    const order = await createOrder(
      shop,
      [orderLine({ itemId: item.id, quantity: 2000, unitPrice: 10_000 })],
      { customerId: customer.id, advanceAmount: 5000, paymentMode: 'upi', dueDate: today() },
    );
    const doc = data<{
      kind: string;
      title: string;
      meta: { label: string; value: string }[];
      totals: { label: string; paise?: number }[];
      tenders: { label: string; paise?: number }[];
    }>(await shop.get(`/v1/sales-orders/${order.id}/print-payload`).expect(200));

    expect(doc.kind).toBe('sales_order');
    expect(doc.title).toBe('SALE ORDER');
    expect(doc.meta.map((m) => m.label)).toEqual(expect.arrayContaining(['Order no.', 'Due date']));
    expect(doc.totals.find((r) => r.label === 'TOTAL')?.paise).toBe(23_600);
    expect(doc.tenders.find((r) => r.label.startsWith('Advance paid'))?.paise).toBe(5000);
    expect(doc.tenders.find((r) => r.label === 'Balance due')?.paise).toBe(18_600);
  });

  it('validates custom fields the way an invoice does', async () => {
    await t
      .post('/v1/custom-fields')
      .send({ key: 'po_number', label: 'PO number', dataType: 'text', isRequired: true, documentTypes: ['sales_order'] })
      .expect(201);
    const lines = [orderLine({ itemId, quantity: 1000, unitPrice: 10_000 })];
    const send = (customFields: Record<string, string>) =>
      t.post('/v1/sales-orders').send({ id: randomUUID(), ...orderBody(t, lines, { customFields }) });

    expect((await send({ colour: 'red' })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    const ok = await send({ po_number: 'PO-77' });
    expect(ok.status).toBe(201);
    expect((data<{ customFields: Record<string, string> }>(ok)).customFields).toEqual({ po_number: 'PO-77' });
  });
});
