/**
 * Estimates, sales orders, purchase orders and suppliers made on a device and pushed later:
 * the numbers the device leased, the operations it queues, and what other devices pull.
 *
 * This is the first suite that drives /v1/sync/changes and /v1/sync/push directly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem } from './setup/fixtures.js';
import { addMember, orderBody, orderLine, setPlan } from './setup/orders.js';
import { data, error } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Block {
  id: string;
  seriesId: string;
  startSeq: number;
  endSeq: number;
  consumedUpTo: number | null;
}
interface Change {
  entity: string;
  op: 'upsert' | 'delete';
  serverSeq: number;
  row: Record<string, unknown>;
}
interface Pulled {
  changes: Change[];
  leases: Block[];
  cursor: number;
}
interface OpResult {
  opId: string;
  type: string;
  status: 'applied' | 'replayed' | 'rejected';
  id?: string;
  retryable?: boolean;
  error?: { code: string; message: string };
  warnings?: { code: string }[];
}

async function pull(who: TenantFixture, since = 0): Promise<Pulled> {
  const changes: Change[] = [];
  const leases: Block[] = [];
  let cursor = since;
  for (;;) {
    const page = data<{ changes: Change[]; leases: Block[]; nextSince: number; hasMore: boolean }>(
      await who.get(`/v1/sync/changes?since=${cursor}&limit=500`).expect(200),
    );
    changes.push(...page.changes);
    leases.push(...page.leases);
    cursor = page.nextSince;
    if (!page.hasMore) break;
  }
  return { changes, leases, cursor };
}

/**
 * A device's first sync. The pull that bootstraps the leases creates the series in the same
 * snapshot it reads, so the series rows themselves arrive on the next pull, as they will on a
 * real phone: lease on the first, series on the second.
 */
async function firstSync(who: TenantFixture): Promise<Pulled> {
  const one = await pull(who);
  const two = await pull(who, one.cursor);
  return {
    changes: [...one.changes, ...two.changes],
    leases: [...one.leases, ...two.leases],
    cursor: two.cursor,
  };
}

async function push(
  who: TenantFixture,
  type: string,
  payload: unknown,
  baseServerSeq?: number,
): Promise<OpResult> {
  const res = await who
    .post('/v1/sync/push')
    .send({
      operations: [
        { opId: randomUUID(), type, payload, ...(baseServerSeq !== undefined ? { baseServerSeq } : {}) },
      ],
    })
    .expect(200);
  return data<{ results: OpResult[] }>(res).results[0]!;
}

const seriesTypes = (changes: Change[]) =>
  new Map(
    changes
      .filter((c) => c.entity === 'document_series')
      .map((c) => [c.row['id'] as string, c.row['documentType'] as string]),
  );

/** The block leased for a document type, and the next number on it. */
function blockFor(p: Pulled, type: string): Block {
  const types = seriesTypes(p.changes);
  const block = p.leases.find((b) => types.get(b.seriesId) === type);
  if (!block) throw new Error(`no ${type} lease; got ${[...types.values()].join(',')}`);
  return block;
}

describe('offline documents through sync', () => {
  let t: TenantFixture;
  let itemId: string;
  let first: Pulled;
  // A plan caps its users, so the suite shares one of each role instead of making one per test.
  let cashier: TenantFixture;
  let manager: TenantFixture;

  const lines = (n = 1) =>
    Array.from({ length: n }, () => orderLine({ itemId, quantity: 2000, unitPrice: 10_000 }));

  beforeAll(async () => {
    t = await createTenant({ name: 'Offline Docs Shop' });
    itemId = (await createItem(t)).id;
    first = await firstSync(t);
    cashier = await addMember(t, 'cashier');
    manager = await addMember(t, 'manager');
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  describe('leases', () => {
    it('leases an owner a block for estimates, sale orders and purchase orders', () => {
      for (const type of ['estimate', 'sales_order', 'purchase_order']) {
        const block = blockFor(first, type);
        expect(block.endSeq).toBeGreaterThanOrEqual(block.startSeq);
      }
    });

    it('leases a cashier only what a cashier may create', async () => {
      const p = await firstSync(cashier);
      const types = seriesTypes(p.changes);
      const leasedTypes = new Set(p.leases.map((b) => types.get(b.seriesId)));
      expect(leasedTypes.has('estimate')).toBe(true);
      expect(leasedTypes.has('sales_order')).toBe(true);
      // purchases:create is withheld from cashiers, so no block is wasted on them.
      expect(leasedTypes.has('purchase_order')).toBe(false);
    });

    it('does not lease sale or estimate blocks on a plan without them', async () => {
      const lite = await createTenant({ name: 'Lite Shop' });
      await setPlan(lite, 'lite', { offline_mode: true, credit_notes: true });
      const p = await firstSync(lite);
      const types = seriesTypes(p.changes);
      const leased = new Set(p.leases.map((b) => types.get(b.seriesId)));
      expect(leased.has('invoice')).toBe(true);
      expect(leased.has('estimate')).toBe(false);
      expect(leased.has('sales_order')).toBe(false);
      expect(leased.has('purchase_order')).toBe(false);
    });
  });

  describe('estimates', () => {
    it('creates an estimate under the number the device leased, once', async () => {
      const block = blockFor(first, 'estimate');
      const seq = block.startSeq;
      const id = randomUUID();
      const payload = {
        id,
        ...orderBody(t, lines()),
        seriesId: block.seriesId,
        sequenceNo: seq,
      };

      const made = await push(t, 'estimate.create', payload);
      expect(made.status).toBe('applied');
      const read = data<{ documentNumber: string }>(await t.get(`/v1/estimates/${id}`).expect(200));
      expect(read.documentNumber).toMatch(new RegExp(`^EST/.+/0*${seq}$`));

      // The same operation again is a replay: nothing new, the number is not spent twice.
      const again = await push(t, 'estimate.create', payload);
      expect(again.status).toBe('replayed');

      // A second estimate cannot reuse the number.
      const clash = await push(t, 'estimate.create', {
        id: randomUUID(),
        ...orderBody(t, lines()),
        seriesId: block.seriesId,
        sequenceNo: seq,
      });
      expect(clash.status).toBe('rejected');
      // The number is already spent: the series' unique index refuses it, as it does for an invoice.
      expect(clash.error?.code).toBe('DUPLICATE');
      expect(clash.retryable).toBe(false);
    });

    it('refuses a number that was never leased to this device', async () => {
      const block = blockFor(first, 'estimate');
      const res = await push(t, 'estimate.create', {
        id: randomUUID(),
        ...orderBody(t, lines()),
        seriesId: block.seriesId,
        sequenceNo: block.endSeq + 1000,
      });
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('NUMBER_NOT_LEASED');
    });

    it('refuses a series of another document type', async () => {
      const wrong = blockFor(first, 'sales_order');
      const res = await push(t, 'estimate.create', {
        id: randomUUID(),
        ...orderBody(t, lines()),
        seriesId: wrong.seriesId,
        sequenceNo: wrong.startSeq + 5,
      });
      expect(res.status).toBe('rejected');
      expect(res.error?.message).toMatch(/not an? estimate series/i);
    });

    it('refuses a seriesId without its sequenceNo', async () => {
      const block = blockFor(first, 'estimate');
      const res = await push(t, 'estimate.create', {
        id: randomUUID(),
        ...orderBody(t, lines()),
        seriesId: block.seriesId,
      });
      expect(res.status).toBe('rejected');
    });

    it('still numbers an estimate made online, without a device number', async () => {
      const id = randomUUID();
      const made = await t
        .post('/v1/estimates')
        .send({ id, ...orderBody(t, lines()) })
        .expect(201);
      expect(data<{ documentNumber: string }>(made).documentNumber).toMatch(/^EST\//);
    });

    it('delivers a line removed in an edit to other devices as a delete', async () => {
      const block = blockFor(first, 'estimate');
      const two = lines(2);
      const id = randomUUID();
      // The device that made it:
      await push(t, 'estimate.create', {
        id,
        ...orderBody(t, two),
        seriesId: block.seriesId,
        sequenceNo: block.startSeq + 1,
      });

      // Another phone pulls the whole thing.
      const before = await pull(manager);
      const linesBefore = before.changes.filter(
        (c) => c.entity === 'estimate_lines' && c.row['estimateId'] === id,
      );
      expect(linesBefore).toHaveLength(2);
      expect(linesBefore.every((c) => c.op === 'upsert')).toBe(true);

      // The first phone edits it down to one line.
      const edited = await push(t, 'estimate.update', {
        id,
        ...orderBody(t, [two[0]!]),
      });
      expect(edited.status).toBe('applied');

      // The other phone's next pull sees the dropped line go.
      const after = await pull(manager, before.cursor);
      const dropped = after.changes.find(
        (c) => c.entity === 'estimate_lines' && c.row['id'] === two[1]!.id,
      );
      expect(dropped?.op).toBe('delete');
      const kept = after.changes.find(
        (c) => c.entity === 'estimate_lines' && c.row['id'] === two[0]!.id,
      );
      expect(kept?.op).toBe('upsert');

      // And the API itself no longer shows it.
      const read = data<{ lines: unknown[] }>(await t.get(`/v1/estimates/${id}`).expect(200));
      expect(read.lines).toHaveLength(1);
    });

    it('lets a removed line come back by sending its id again', async () => {
      const block = blockFor(first, 'estimate');
      const two = lines(2);
      const id = randomUUID();
      await push(t, 'estimate.create', {
        id,
        ...orderBody(t, two),
        seriesId: block.seriesId,
        sequenceNo: block.startSeq + 2,
      });
      await push(t, 'estimate.update', { id, ...orderBody(t, [two[0]!]) });
      const back = await push(t, 'estimate.update', { id, ...orderBody(t, two) });
      expect(back.status).toBe('applied');
      const read = data<{ lines: unknown[] }>(await t.get(`/v1/estimates/${id}`).expect(200));
      expect(read.lines).toHaveLength(2);
    });

    it('rejects an edit made on top of a newer version', async () => {
      const id = randomUUID();
      const made = await t
        .post('/v1/estimates')
        .send({ id, ...orderBody(t, lines()) })
        .expect(201);
      void made;
      const seqNow = (await pull(t)).changes
        .filter((c) => c.entity === 'estimates' && c.row['id'] === id)
        .map((c) => c.serverSeq)
        .at(-1)!;
      // Someone else edits it first.
      await t
        .put(`/v1/estimates/${id}`)
        .send({ ...orderBody(t, lines()), notes: 'changed elsewhere' })
        .expect(200);

      const stale = await push(t, 'estimate.update', { id, ...orderBody(t, lines()) }, seqNow);
      expect(stale.status).toBe('rejected');
      expect(stale.error?.code).toBe('STALE_WRITE');
    });

    it('converts to a sale order offline under a leased number, and freezes the estimate', async () => {
      const estBlock = blockFor(first, 'estimate');
      const soBlock = blockFor(first, 'sales_order');
      const estimateId = randomUUID();
      await push(t, 'estimate.create', {
        id: estimateId,
        ...orderBody(t, lines()),
        seriesId: estBlock.seriesId,
        sequenceNo: estBlock.startSeq + 3,
      });

      const orderId = randomUUID();
      const converted = await push(t, 'estimate.convert', {
        id: estimateId,
        orderId,
        target: 'sales_order',
        seriesId: soBlock.seriesId,
        sequenceNo: soBlock.startSeq,
      });
      expect(converted.status).toBe('applied');

      const order = data<{ documentNumber: string; estimateId: string }>(
        await t.get(`/v1/sales-orders/${orderId}`).expect(200),
      );
      expect(order.estimateId).toBe(estimateId);
      expect(order.documentNumber).toMatch(new RegExp(`^SO/.+/0*${soBlock.startSeq}$`));

      const again = await push(t, 'estimate.convert', {
        id: estimateId,
        orderId: randomUUID(),
        target: 'sales_order',
        seriesId: soBlock.seriesId,
        sequenceNo: soBlock.startSeq + 1,
      });
      expect(again.status).toBe('rejected');
      expect(again.error?.code).toBe('ESTIMATE_ALREADY_CONVERTED');
      expect(again.retryable).toBe(false);
    });
  });

  describe('sale orders', () => {
    it('creates, edits and cancels through push, with the leased number', async () => {
      const block = blockFor(first, 'sales_order');
      const id = randomUUID();
      const made = await push(t, 'sale_order.create', {
        id,
        ...orderBody(t, lines()),
        seriesId: block.seriesId,
        sequenceNo: block.startSeq + 5,
      });
      expect(made.status).toBe('applied');

      const edited = await push(t, 'sale_order.update', {
        id,
        ...orderBody(t, lines(2), { notes: 'two lines now' }),
      });
      expect(edited.status).toBe('applied');
      const read = data<{ lines: unknown[]; notes: string }>(
        await t.get(`/v1/sales-orders/${id}`).expect(200),
      );
      expect(read.lines).toHaveLength(2);
      expect(read.notes).toBe('two lines now');

      const cancelled = await push(t, 'sale_order.cancel', { id, reason: 'changed mind' });
      expect(cancelled.status).toBe('applied');
      expect(
        data<{ status: string }>(await t.get(`/v1/sales-orders/${id}`).expect(200)).status,
      ).toBe('cancelled');
    });

    it('records a discount over the shop limit and warns, where typing it online is refused', async () => {
      await t.put('/v1/discount-policies').send({ maxBillDiscountPercent: 5 }).expect(200);
      try {
        const block = blockFor(first, 'sales_order');
        const l = [orderLine({ itemId, quantity: 2000, unitPrice: 10_000 })];
        const totals = { taxableAmount: 18_000, totalTax: 3240, grandTotal: 21_240 };
        const discounted = {
          billDiscount: { kind: 'percent' as const, value: 10 },
        };

        const online = await t
          .post('/v1/sales-orders')
          .send({ id: randomUUID(), ...orderBody(t, l, discounted, totals) })
          .expect(422);
        expect(error(online).code).toBe('DISCOUNT_CAP_EXCEEDED');

        const offline = await push(t, 'sale_order.create', {
          id: randomUUID(),
          ...orderBody(t, l, discounted, totals),
          seriesId: block.seriesId,
          sequenceNo: block.startSeq + 6,
        });
        expect(offline.status).toBe('applied');
        expect(offline.warnings?.map((w) => w.code)).toContain('DISCOUNT_CAP_EXCEEDED');
      } finally {
        await t.put('/v1/discount-policies').send({ maxBillDiscountPercent: null }).expect(200);
      }
    });

    it('rejects an edit by a cashier, who may create but not update', async () => {
      const id = randomUUID();
      await t.post('/v1/sales-orders').send({ id, ...orderBody(t, lines()) }).expect(201);
      const res = await push(cashier, 'sale_order.update', { id, ...orderBody(t, lines()) });
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('INSUFFICIENT_ROLE');
      expect(res.retryable).toBe(false);
    });

    it('lets a removed order line reach other devices as a delete', async () => {
      const block = blockFor(first, 'sales_order');
      const two = lines(2);
      const id = randomUUID();
      await push(t, 'sale_order.create', {
        id,
        ...orderBody(t, two),
        seriesId: block.seriesId,
        sequenceNo: block.startSeq + 7,
      });
      const before = await pull(manager);
      await push(t, 'sale_order.update', { id, ...orderBody(t, [two[0]!]) });
      const after = await pull(manager, before.cursor);
      expect(
        after.changes.find((c) => c.entity === 'sales_order_lines' && c.row['id'] === two[1]!.id)?.op,
      ).toBe('delete');
    });

    it('a removed line no longer reserves stock or counts as pending', async () => {
      const id = randomUUID();
      const two = lines(2);
      await t.post('/v1/sales-orders').send({ id, ...orderBody(t, two) }).expect(201);
      await t
        .put(`/v1/sales-orders/${id}`)
        .send(orderBody(t, [two[0]!]))
        .expect(200);
      const read = data<{ lines: { quantityPending: number }[] }>(
        await t.get(`/v1/sales-orders/${id}`).expect(200),
      );
      expect(read.lines).toHaveLength(1);
      expect(read.lines[0]!.quantityPending).toBe(2000);
    });
  });

  describe('purchase orders and suppliers', () => {
    const supplierPayload = (id = randomUUID()) => ({ id, name: `Supplier ${id.slice(0, 6)}` });

    it('creates a supplier through push and other devices pull it', async () => {
      const supplier = supplierPayload();
      const made = await push(t, 'supplier.create', supplier);
      expect(made.status).toBe('applied');
      const pulled = await pull(t);
      expect(
        pulled.changes.some((c) => c.entity === 'suppliers' && c.row['id'] === supplier.id),
      ).toBe(true);

      const renamed = await push(t, 'supplier.update', {
        id: supplier.id,
        patch: { name: 'Renamed Traders' },
      });
      expect(renamed.status).toBe('applied');
    });

    it('creates a purchase order against that supplier with a leased number', async () => {
      const supplier = supplierPayload();
      await push(t, 'supplier.create', supplier);
      const block = blockFor(first, 'purchase_order');
      const id = randomUUID();
      const made = await push(t, 'purchase_order.create', {
        id,
        outletId: t.outletId,
        supplierId: supplier.id,
        documentDate: new Date().toISOString().slice(0, 10),
        lines: [
          { id: randomUUID(), itemId, quantityOrdered: 5000, expectedUnitCost: 4_000 },
          { id: randomUUID(), itemId, quantityOrdered: 1000, expectedUnitCost: 4_000 },
        ],
        seriesId: block.seriesId,
        sequenceNo: block.startSeq,
      });
      expect(made.status).toBe('applied');
      const read = data<{ documentNumber: string; lines: { id: string }[] }>(
        await t.get(`/v1/purchase-orders/${id}`).expect(200),
      );
      expect(read.documentNumber).toMatch(new RegExp(`^PO/.+/0*${block.startSeq}$`));
      expect(read.lines).toHaveLength(2);

      // Dropping a line reaches other devices as a delete.
      const before = await pull(t);
      await push(t, 'purchase_order.update', {
        id,
        outletId: t.outletId,
        supplierId: supplier.id,
        documentDate: new Date().toISOString().slice(0, 10),
        lines: [
          { id: read.lines[0]!.id, itemId, quantityOrdered: 5000, expectedUnitCost: 4_000 },
        ],
      });
      const after = await pull(t, before.cursor);
      expect(
        after.changes.find(
          (c) => c.entity === 'purchase_order_lines' && c.row['id'] === read.lines[1]!.id,
        )?.op,
      ).toBe('delete');

      const cancelled = await push(t, 'purchase_order.cancel', { id, reason: 'not needed' });
      expect(cancelled.status).toBe('applied');
    });

    it('rejects purchase operations from a cashier', async () => {
      const res = await push(cashier, 'supplier.create', supplierPayload());
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('INSUFFICIENT_ROLE');
    });

    it('a retried delete of something already gone is not an error', async () => {
      const supplier = supplierPayload();
      await push(t, 'supplier.create', supplier);
      expect((await push(t, 'supplier.delete', { id: supplier.id })).status).toBe('applied');
      expect((await push(t, 'supplier.delete', { id: supplier.id })).status).toBe('applied');
    });
  });

  describe('isolation', () => {
    it('never shows one business another business’s documents or numbers', async () => {
      const stranger = await createTenant({ name: 'Stranger Shop' });
      const p = await pull(stranger);
      const mine = first.changes.filter((c) =>
        ['estimates', 'sales_orders', 'purchase_orders', 'suppliers'].includes(c.entity),
      );
      const theirs = new Set(
        p.changes
          .filter((c) => ['estimates', 'sales_orders', 'purchase_orders', 'suppliers'].includes(c.entity))
          .map((c) => c.row['id']),
      );
      for (const c of mine) expect(theirs.has(c.row['id'])).toBe(false);

      // And cannot spend a lease that belongs to another business.
      const block = blockFor(first, 'estimate');
      const res = await push(stranger, 'estimate.create', {
        id: randomUUID(),
        ...orderBody(stranger, lines()),
        seriesId: block.seriesId,
        sequenceNo: block.startSeq + 20,
      });
      expect(res.status).toBe('rejected');
    });
  });
});
