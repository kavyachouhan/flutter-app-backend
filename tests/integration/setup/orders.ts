/**
 * Helpers for the sales-order suites: a member with another role, a tenant moved to
 * another plan, and the payloads an order and its invoices need.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { data } from './body.js';
import { ownerClient } from './database.js';
import {
  expectedTotals,
  invoicePayload,
  today,
  type InvoiceLineSpec,
} from './fixtures.js';
import { app, type TenantFixture } from './tenant.js';

/** A second person in the same business, signed in with their own role. */
export async function addMember(
  owner: TenantFixture,
  role: 'manager' | 'cashier' | 'accountant' | 'viewer',
): Promise<TenantFixture> {
  const phone = `9${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
  await owner
    .post('/v1/members')
    .send({ phone, name: `Test ${role}`, role, outletIds: null })
    .expect(201);

  const login = await request(app)
    .post('/v1/auth/dev-login')
    .send({
      phone,
      name: `Test ${role}`,
      tenantId: owner.tenantId,
      device: { deviceKey: randomUUID(), platform: 'android', label: `${role}-device` },
    })
    .expect(200);
  const session = data<{ session: { accessToken: string; userId: string; deviceId: string } }>(
    login,
  ).session;
  const auth = `Bearer ${session.accessToken}`;
  return {
    ...owner,
    userId: session.userId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
    phone,
    get: (path) => request(app).get(path).set('Authorization', auth),
    post: (path) => request(app).post(path).set('Authorization', auth),
    patch: (path) => request(app).patch(path).set('Authorization', auth),
    put: (path) => request(app).put(path).set('Authorization', auth),
    del: (path) => request(app).delete(path).set('Authorization', auth),
  };
}

/** Moves a tenant to a plan by rewriting its subscription, as an operator would. */
export async function setPlan(
  t: TenantFixture,
  plan: 'trial' | 'lite' | 'standard' | 'pro',
  features: Record<string, boolean | string>,
): Promise<void> {
  const c = await ownerClient();
  await c.query('UPDATE subscriptions SET plan = $2, features = $3::jsonb WHERE tenant_id = $1', [
    t.tenantId,
    plan,
    JSON.stringify(features),
  ]);
}

export async function setAllowNegativeStock(t: TenantFixture, allow: boolean): Promise<void> {
  const c = await ownerClient();
  await c.query('UPDATE tenants SET allow_negative_stock = $2 WHERE id = $1', [t.tenantId, allow]);
}

export interface OrderLineSpec {
  id?: string;
  itemId?: string;
  itemName?: string;
  quantity: number;
  unitPrice: number;
  taxRatePercent?: number;
  discount?: { kind: 'amount' | 'percent'; value: number };
  unit?: string;
}

export function orderLine(spec: OrderLineSpec) {
  return {
    id: spec.id ?? randomUUID(),
    ...(spec.itemId ? { itemId: spec.itemId } : {}),
    ...(spec.itemName ? { itemName: spec.itemName } : {}),
    ...(spec.unit ? { unit: spec.unit } : {}),
    quantity: spec.quantity,
    unitPrice: spec.unitPrice,
    taxRatePercent: spec.taxRatePercent ?? 18,
    ...(spec.discount ? { discount: spec.discount } : {}),
  };
}

type Line = ReturnType<typeof orderLine>;

/**
 * An order body. Totals are worked out the long way (see `expectedTotals`) for plain
 * lines; pass `totals` for anything with discounts or charges so the server's engine is
 * not asked to agree with itself.
 */
export function orderBody(
  t: TenantFixture,
  lines: Line[],
  extra: Record<string, unknown> = {},
  totals?: { grandTotal: number; totalTax: number; taxableAmount: number },
) {
  return {
    outletId: t.outletId,
    documentDate: today(),
    customerName: 'Walk-in Ravi',
    placeOfSupplyStateCode: '27',
    pricesIncludeTax: false,
    roundOff: false,
    lines,
    expectedTotals:
      totals ??
      expectedTotals(
        lines.map(
          (l): InvoiceLineSpec => ({
            itemId: l.itemId ?? '',
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRatePercent: l.taxRatePercent,
          }),
        ),
      ),
    ...extra,
  };
}

export interface OrderView {
  id: string;
  documentNumber: string;
  status: 'open' | 'partial' | 'closed' | 'cancelled';
  grandTotal: number;
  advanceAmount: number;
  advanceRefunded: number;
  advanceApplied: number;
  advanceRemaining: number;
  balanceDue: number;
  billDiscountAmount: number;
  billDiscountRemaining: number;
  customerId: string | null;
  invoices: { id: string; status: string; amendsInvoiceId: string | null; billDiscountAmount: number }[];
  lines: {
    id: string;
    itemId: string | null;
    quantity: number;
    quantityFulfilled: number;
    quantityPending: number;
  }[];
}

export async function createOrder(
  t: TenantFixture,
  lines: Line[],
  extra: Record<string, unknown> = {},
  totals?: { grandTotal: number; totalTax: number; taxableAmount: number },
): Promise<OrderView> {
  const res = await t
    .post('/v1/sales-orders')
    .send({ id: randomUUID(), ...orderBody(t, lines, extra, totals) })
    .expect(201);
  return data<OrderView>(res);
}

export async function getOrder(t: TenantFixture, id: string): Promise<OrderView> {
  return data<OrderView>(await t.get(`/v1/sales-orders/${id}`).expect(200));
}

/** What a stock adjustment needs to put units on the shelf. */
export async function stockIn(
  t: TenantFixture,
  itemId: string,
  quantity: number,
): Promise<void> {
  await t
    .post('/v1/stock/adjustments')
    .send({
      id: randomUUID(),
      outletId: t.outletId,
      itemId,
      quantityDelta: quantity,
      reasonCode: 'opening',
      occurredAt: new Date().toISOString(),
    })
    .expect(201);
}

export interface Balance {
  itemId: string;
  quantity: number;
  reserved: number;
  available: number;
}

export async function balanceOf(t: TenantFixture, itemId: string): Promise<Balance> {
  const res = await t.get(`/v1/stock/balances?outletId=${t.outletId}&itemId=${itemId}`).expect(200);
  const rows = data<Balance[]>(res);
  return rows[0] ?? { itemId, quantity: 0, reserved: 0, available: 0 };
}

export interface InvoiceSeries {
  seriesId: string;
  next: () => number;
}

/** A request to raise an invoice against an order for the given pending quantities. */
export function orderInvoiceRequest(
  t: TenantFixture,
  series: InvoiceSeries,
  order: OrderView,
  quantities: number[],
  extra: Record<string, unknown> = {},
) {
  const used = order.lines
    .map((l, i) => ({
      id: randomUUID(),
      ...(l.itemId ? { itemId: l.itemId } : { itemName: 'Custom item' }),
      quantity: quantities[i] ?? 0,
      unitPrice: 10_000,
      taxRatePercent: 18,
      salesOrderLineId: l.id,
    }))
    .filter((l) => l.quantity > 0);
  const specs = used.map((l) => ({
    itemId: 'itemId' in l ? l.itemId : '',
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    taxRatePercent: l.taxRatePercent,
  }));
  return {
    ...invoicePayload(t, {
      seriesId: series.seriesId,
      sequenceNo: series.next(),
      customerId: order.customerId,
      lines: specs,
    }),
    salesOrderId: order.id,
    lines: used,
    expectedTotals: expectedTotals(specs),
    ...extra,
  };
}
