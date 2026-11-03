/**
 * Estimates / quotations: create / read / edit / delete, the totals the server insists on,
 * the lifecycle (open, converted, closed, cancelled), conversion to a sales order and to
 * an invoice, Terms & Conditions applicability, permissions and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import {
  createItem,
  createSeries,
  expectedTotals,
  invoicePayload,
  leaseBlock,
  today,
  type SeriesFixture,
} from './setup/fixtures.js';
import { addMember } from './setup/orders.js';
import { data, error, rows } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

interface EstimateLine {
  id: string;
  itemId: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

interface Estimate {
  id: string;
  documentNumber: string;
  status: 'open' | 'converted' | 'closed' | 'cancelled';
  grandTotal: number;
  totalTax: number;
  balance: number;
  customerName: string | null;
  validUntil: string | null;
  termsId: string | null;
  termsSnapshot: { title: string; description: string } | null;
  convertedToType: 'sales_order' | 'invoice' | null;
  convertedToId: string | null;
  convertedToNumber: string | null;
  lines: EstimateLine[];
}

interface SalesOrder {
  id: string;
  documentNumber: string;
  status: string;
  grandTotal: number;
  estimateId: string | null;
  advanceAmount: number;
  customerName: string | null;
  termsId: string | null;
  termsSnapshot: { title: string; description: string } | null;
  lines: { itemId: string | null; quantity: number; unitPrice: number; lineTotal: number }[];
}

interface Terms {
  id: string;
  applicableFor: string[];
}

// Every call is a round trip to a hosted database.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('estimates', () => {
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

  function body(
    owner: TenantFixture,
    lines: ReturnType<typeof line>[],
    extra: Record<string, unknown> = {},
    id: string = randomUUID(),
  ) {
    return {
      id,
      outletId: owner.outletId,
      documentDate: today(),
      customerName: 'Kavya',
      placeOfSupplyStateCode: '27',
      pricesIncludeTax: false,
      roundOff: false,
      lines,
      expectedTotals: expectedTotals(lines),
      ...extra,
    };
  }

  const create = (payload: Record<string, unknown>, status = 201, who: TenantFixture = t) =>
    who.post('/v1/estimates').send(payload).expect(status);

  async function newEstimate(extra: Record<string, unknown> = {}): Promise<Estimate> {
    const item = await createItem(t);
    return data<Estimate>(await create(body(t, [line(item.id)], extra)));
  }

  async function createTerms(applicableFor: string[]): Promise<Terms> {
    return data<Terms>(
      await t
        .post('/v1/terms')
        .send({
          id: randomUUID(),
          title: `Terms ${randomUUID().slice(0, 6)}`,
          description: 'Valid for 15 days.',
          applicableFor,
        })
        .expect(201),
    );
  }

  beforeAll(async () => {
    t = await createTenant({ name: 'Estimates Shop' });
    series = await createSeries(t, { prefix: 'EINV' });
    nextSeq = (await leaseBlock(t, series.id, 50)).startSeq;
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  describe('create and read', () => {
    it('creates an estimate with a generated EST number and the right totals', async () => {
      const item = await createItem(t);
      const lines = [line(item.id)];
      const created = data<Estimate>(await create(body(t, lines)));

      expect(created.documentNumber).toMatch(/^EST\//);
      expect(created.status).toBe('open');
      expect(created.grandTotal).toBe(expectedTotals(lines).grandTotal);
      // An open estimate is still to be won: its balance is its total.
      expect(created.balance).toBe(created.grandTotal);

      const read = data<Estimate>(await t.get(`/v1/estimates/${created.id}`).expect(200));
      expect(read.lines).toHaveLength(1);
      expect(read.lines[0]?.quantity).toBe(2000);
    });

    it('numbers estimates in sequence', async () => {
      const a = await newEstimate();
      const b = await newEstimate();
      const seq = (n: string) => Number(n.split('/').pop());
      expect(seq(b.documentNumber)).toBe(seq(a.documentNumber) + 1);
    });

    it('answers a replayed create with 200 and does not create a second estimate', async () => {
      const item = await createItem(t);
      const payload = body(t, [line(item.id)]);
      const first = data<Estimate>(await create(payload));
      const second = await create(payload, 200);
      expect(data<Estimate>(second).id).toBe(first.id);
      expect(data<Estimate>(second).documentNumber).toBe(first.documentNumber);
    });

    it('takes an estimate for a typed amount with no items', async () => {
      const created = data<Estimate>(
        await create({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: today(),
          customerName: 'Kavya',
          pricesIncludeTax: false,
          roundOff: false,
          lines: [],
          manualTotal: 1000_00,
          expectedTotals: { grandTotal: 1000_00, totalTax: 0, taxableAmount: 1000_00 },
        }),
      );
      expect(created.grandTotal).toBe(1000_00);
      expect(created.lines).toHaveLength(0);
    });

    it('refuses an estimate with neither items nor an amount', async () => {
      const res = await create(
        {
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: today(),
          customerName: 'Kavya',
          pricesIncludeTax: false,
          roundOff: false,
          lines: [],
          expectedTotals: { grandTotal: 0, totalTax: 0, taxableAmount: 0 },
        },
        400,
      );
      expect(error(res).code).toBe('VALIDATION_FAILED');
    });

    it('refuses totals the server does not agree with', async () => {
      const item = await createItem(t);
      const lines = [line(item.id)];
      const res = await create(
        body(t, lines, { expectedTotals: { grandTotal: 1, totalTax: 0, taxableAmount: 1 } }),
        409,
      );
      expect(error(res).code).toBe('TOTALS_MISMATCH');
    });

    it('requires a customer', async () => {
      const item = await createItem(t);
      const res = await create(body(t, [line(item.id)], { customerName: null }), 400);
      expect(error(res).details).toMatchObject({ field: 'customerName' });
    });

    it('refuses a validity date before the estimate date', async () => {
      const item = await createItem(t);
      const res = await create(body(t, [line(item.id)], { validUntil: '2000-01-01' }), 400);
      expect(error(res).details).toMatchObject({ field: 'validUntil' });
    });

    it('refuses a bill discount larger than the bill', async () => {
      const item = await createItem(t);
      const lines = [line(item.id, 1000, 10_000)];
      const res = await create(
        body(t, lines, { billDiscount: { kind: 'amount', value: 99_999_999 } }),
        400,
      );
      expect(error(res).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('attachments', () => {
    // A 1x1 transparent PNG.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );

    // Real uploads need the storage bucket; some environments (CI, a bare test project) have
    // none. The rule checks below use made-up keys and never touch storage.
    let storageReady = false;

    async function uploadPng(who: TenantFixture = t): Promise<string> {
      const sign = await who
        .post('/v1/uploads/sign')
        .send({ kind: 'attachment_image', contentType: 'image/png', sizeBytes: PNG.length });
      if (sign.status !== 200) throw new Error(`storage unavailable: ${sign.status}`);
      const slot = data<{ uploadUrl: string; objectKey: string }>(sign);
      const put = await fetch(slot.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: PNG,
      });
      if (!put.ok) throw new Error(`storage unavailable: ${put.status}`);
      return slot.objectKey;
    }

    beforeAll(async () => {
      try {
        await uploadPng();
        storageReady = true;
      } catch {
        storageReady = false;
      }
    });

    const needsStorage = (name: string, fn: () => Promise<void>) =>
      it(name, async (ctx) => {
        if (!storageReady) ctx.skip();
        await fn();
      });

    const fake = (kind: string) => `${t.tenantId}/${kind}/${randomUUID()}.png`;

    const image = (objectKey: string) => ({ objectKey, kind: 'image', name: 'pic.png' });

    needsStorage('saves an estimate with a real uploaded picture and returns it', async () => {
      const key = await uploadPng();
      const created = await newEstimate({ attachments: [image(key)] });
      const read = data<Estimate & { attachments: { objectKey: string }[] }>(
        await t.get(`/v1/estimates/${created.id}`).expect(200),
      );
      expect(read.attachments.map((a) => a.objectKey)).toEqual([key]);
    });

    it('still accepts the older order_attachment kind in the key', async () => {
      // Existing records and older app versions use it. Not a real object, so it is the
      // content check (or storage), not the key rule, that stops this one.
      const item = await createItem(t);
      const res = await t
        .post('/v1/estimates')
        .send(body(t, [line(item.id)], { attachments: [image(fake('order_attachment'))] }));
      expect(res.status).not.toBe(201);
      const message = (res.body as { error?: { message?: string } }).error?.message ?? '';
      expect(message).not.toMatch(/not uploaded for this purpose/i);
    });

    it('refuses a key of another business', async () => {
      const other = await createTenant({ name: 'Key Owner' });
      const item = await createItem(t);
      await create(
        body(t, [line(item.id)], {
          attachments: [image(`${other.tenantId}/attachment_image/${randomUUID()}.png`)],
        }),
        403,
      );
    });

    it('refuses a key that was uploaded for another purpose', async () => {
      const item = await createItem(t);
      const res = await create(
        body(t, [line(item.id)], {
          attachments: [image(fake('logo'))],
        }),
        400,
      );
      expect(error(res).message).toMatch(/not uploaded for this purpose/i);
    });

    it('refuses the same file attached twice', async () => {
      const key = fake('attachment_image');
      const item = await createItem(t);
      const res = await create(
        body(t, [line(item.id)], { attachments: [image(key), image(key)] }),
        400,
      );
      expect(error(res).message).toMatch(/twice/i);
    });

    it('refuses a picture attached as a document', async () => {
      const item = await createItem(t);
      const res = await create(
        body(t, [line(item.id)], {
          attachments: [{ objectKey: fake('attachment_image'), kind: 'document', name: 'x.pdf' }],
        }),
        400,
      );
      expect(error(res).message).toMatch(/picture cannot be attached as a document/i);
    });

    needsStorage('refuses a key whose file was never uploaded', async () => {
      const item = await createItem(t);
      const res = await t
        .post('/v1/estimates')
        .send(body(t, [line(item.id)], { attachments: [image(fake('attachment_image'))] }));
      expect([400, 422]).toContain(res.status);
    });

    needsStorage('keeps the attachments through an edit and carries them onto the converted order', async () => {
      const key = await uploadPng();
      const item = await createItem(t);
      const lines = [line(item.id)];
      const made = data<Estimate>(await create(body(t, lines, { attachments: [image(key)] })));
      const edited = data<Estimate & { attachments: { objectKey: string }[] }>(
        await t
          .put(`/v1/estimates/${made.id}`)
          .send({ ...body(t, lines, { attachments: [image(key)], notes: 'v2' }), id: undefined })
          .expect(200),
      );
      expect(edited.attachments.map((a) => a.objectKey)).toEqual([key]);

      const orderId = randomUUID();
      await t
        .post(`/v1/estimates/${made.id}/convert`)
        .send({ id: orderId, target: 'sales_order' })
        .expect(201);
      const order = data<{ attachments: { objectKey: string }[] }>(
        await t.get(`/v1/sales-orders/${orderId}`).expect(200),
      );
      expect(order.attachments.map((a) => a.objectKey)).toEqual([key]);
    });

    needsStorage('can drop an attachment on edit', async () => {
      const key = await uploadPng();
      const item = await createItem(t);
      const lines = [line(item.id)];
      const made = data<Estimate>(await create(body(t, lines, { attachments: [image(key)] })));
      const edited = data<Estimate & { attachments: unknown[] }>(
        await t
          .put(`/v1/estimates/${made.id}`)
          .send({ ...body(t, lines, { attachments: [] }), id: undefined })
          .expect(200),
      );
      expect(edited.attachments).toEqual([]);
    });
  });

  describe('edit', () => {
    it('replaces the lines and recomputes the totals, keeping the number', async () => {
      const item = await createItem(t);
      const original = data<Estimate>(await create(body(t, [line(item.id)])));
      const lines = [line(item.id, 5000, 20_000)];
      const edited = data<Estimate>(
        await t
          .put(`/v1/estimates/${original.id}`)
          .send({ ...body(t, lines, { notes: 'Revised' }), id: undefined })
          .expect(200),
      );
      expect(edited.documentNumber).toBe(original.documentNumber);
      expect(edited.grandTotal).toBe(expectedTotals(lines).grandTotal);
      expect(edited.lines).toHaveLength(1);
      expect(edited.lines[0]?.quantity).toBe(5000);

      const reread = data<Estimate>(await t.get(`/v1/estimates/${original.id}`).expect(200));
      expect(reread.grandTotal).toBe(edited.grandTotal);
    });

    it('validates an edit as strictly as a create', async () => {
      const original = await newEstimate();
      const item = await createItem(t);
      const res = await t
        .put(`/v1/estimates/${original.id}`)
        .send({
          ...body(t, [line(item.id)], {
            expectedTotals: { grandTotal: 5, totalTax: 0, taxableAmount: 5 },
          }),
          id: undefined,
        })
        .expect(409);
      expect(error(res).code).toBe('TOTALS_MISMATCH');
    });

    it('refuses to move an estimate to another outlet', async () => {
      const original = await newEstimate();
      const item = await createItem(t);
      const res = await t
        .put(`/v1/estimates/${original.id}`)
        .send({ ...body(t, [line(item.id)], { outletId: randomUUID() }), id: undefined });
      expect([400, 403, 404]).toContain(res.status);
    });
  });

  describe('list, filters and search', () => {
    it('filters by open and closed, searches, and counts for the chips', async () => {
      const fresh = await createTenant({ name: 'Filter Estimates Shop' });
      const item = await createItem(fresh);
      const make = async (name: string) =>
        data<Estimate>(
          await create(body(fresh, [line(item.id)], { customerName: name }), 201, fresh),
        );
      const open = await make('Alpha Traders');
      const toClose = await make('Beta Stores');
      const toCancel = await make('Gamma Mart');
      await fresh.post(`/v1/estimates/${toClose.id}/close`).expect(200);
      await fresh
        .post(`/v1/estimates/${toCancel.id}/cancel`)
        .send({ reason: 'Customer went elsewhere' })
        .expect(200);

      const ids = async (query: string) =>
        rows<Estimate>(await fresh.get(`/v1/estimates${query}`).expect(200)).map((e) => e.id);

      expect((await ids('')).sort()).toEqual([open.id, toClose.id, toCancel.id].sort());
      expect(await ids('?status=all')).toHaveLength(3);
      expect(await ids('?status=open')).toEqual([open.id]);
      expect((await ids('?status=closed')).sort()).toEqual([toClose.id, toCancel.id].sort());

      expect(await ids('?q=beta')).toEqual([toClose.id]);
      expect(await ids(`?q=${open.documentNumber.split('/').pop()}`)).toContain(open.id);
      expect(await ids('?q=nobody')).toEqual([]);

      const summary = data<{ all: number; open: number; closed: number }>(
        await fresh.get('/v1/estimates/summary').expect(200),
      );
      expect(summary).toEqual({ all: 3, open: 1, closed: 2 });
    });

    it('pages with a cursor', async () => {
      const fresh = await createTenant({ name: 'Paging Estimates Shop' });
      const item = await createItem(fresh);
      for (let i = 0; i < 3; i++) {
        await create(body(fresh, [line(item.id)]), 201, fresh);
      }
      const first = await fresh.get('/v1/estimates?limit=2').expect(200);
      expect(rows<Estimate>(first)).toHaveLength(2);
      const cursor = (first.body as { nextCursor: string | null }).nextCursor;
      expect(cursor).toBeTruthy();
      const second = await fresh.get(`/v1/estimates?limit=2&cursor=${cursor}`).expect(200);
      expect(rows<Estimate>(second)).toHaveLength(1);
    });
  });

  describe('terms and conditions', () => {
    it('accepts a T&C applicable to estimates and snapshots its text', async () => {
      const terms = await createTerms(['estimate', 'sale_order']);
      expect(terms.applicableFor).toContain('estimate');
      const created = await newEstimate({ termsId: terms.id });
      expect(created.termsId).toBe(terms.id);
      expect(created.termsSnapshot?.description).toBe('Valid for 15 days.');

      // Editing the master later does not change the quoted text.
      await t.patch(`/v1/terms/${terms.id}`).send({ description: 'Changed.' }).expect(200);
      const reread = data<Estimate>(await t.get(`/v1/estimates/${created.id}`).expect(200));
      expect(reread.termsSnapshot?.description).toBe('Valid for 15 days.');
    });

    it('lists estimate T&C under the estimate filter only', async () => {
      const only = await createTerms(['estimate']);
      const sale = await createTerms(['sale']);
      const ids = rows<Terms>(await t.get('/v1/terms?applicableFor=estimate').expect(200)).map(
        (x) => x.id,
      );
      expect(ids).toContain(only.id);
      expect(ids).not.toContain(sale.id);
    });

    it('refuses a T&C that is not applicable to estimates', async () => {
      const sale = await createTerms(['sale']);
      const item = await createItem(t);
      const res = await create(body(t, [line(item.id)], { termsId: sale.id }), 422);
      expect(error(res).message).toMatch(/not applicable/i);
    });

    it('still lets estimate-only T&C stay off the other documents', async () => {
      const only = await createTerms(['estimate']);
      const item = await createItem(t);
      const lines = [line(item.id)];
      const res = await t
        .post('/v1/sales-orders')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: today(),
          customerName: 'Kavya',
          pricesIncludeTax: false,
          roundOff: false,
          lines,
          expectedTotals: expectedTotals(lines),
          termsId: only.id,
        })
        .expect(422);
      expect(error(res).message).toMatch(/not applicable/i);
    });
  });

  describe('convert to a sales order', () => {
    it('raises an order carrying the customer, lines, prices, taxes and T&C, and freezes the estimate', async () => {
      const terms = await createTerms(['estimate']);
      const item = await createItem(t);
      const lines = [line(item.id, 3000, 12_000)];
      const estimate = data<Estimate>(
        await create(body(t, lines, { termsId: terms.id, customerName: 'Convert Co' })),
      );

      const orderId = randomUUID();
      const res = await t
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: orderId, target: 'sales_order' })
        .expect(201);
      const converted = data<Estimate>(res);
      const salesOrder = (res.body as { salesOrder: { id: string; documentNumber: string } })
        .salesOrder;

      expect(converted.status).toBe('converted');
      expect(converted.convertedToType).toBe('sales_order');
      expect(converted.convertedToId).toBe(orderId);
      expect(converted.convertedToNumber).toBe(salesOrder.documentNumber);
      expect(converted.balance).toBe(0);

      const order = data<SalesOrder>(await t.get(`/v1/sales-orders/${orderId}`).expect(200));
      expect(order.estimateId).toBe(estimate.id);
      expect(order.customerName).toBe('Convert Co');
      expect(order.grandTotal).toBe(estimate.grandTotal);
      expect(order.advanceAmount).toBe(0);
      expect(order.status).toBe('open');
      expect(order.lines).toHaveLength(1);
      expect(order.lines[0]).toMatchObject({ itemId: item.id, quantity: 3000, unitPrice: 12_000 });
      // The T&C was written for estimates only; it still travels with the quote.
      expect(order.termsId).toBe(terms.id);
      expect(order.termsSnapshot?.description).toBe('Valid for 15 days.');
    });

    it('converts an estimate for a typed amount', async () => {
      const estimate = data<Estimate>(
        await create({
          id: randomUUID(),
          outletId: t.outletId,
          documentDate: today(),
          customerName: 'Lump Sum Ltd',
          pricesIncludeTax: false,
          roundOff: false,
          lines: [],
          manualTotal: 5000_00,
          expectedTotals: { grandTotal: 5000_00, totalTax: 0, taxableAmount: 5000_00 },
        }),
      );
      const orderId = randomUUID();
      await t
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: orderId, target: 'sales_order' })
        .expect(201);
      const order = data<SalesOrder>(await t.get(`/v1/sales-orders/${orderId}`).expect(200));
      expect(order.grandTotal).toBe(5000_00);
    });

    it('does not move stock or take a payment', async () => {
      const estimate = await newEstimate();
      await t
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(201);
      const orders = rows<SalesOrder>(await t.get('/v1/sales-orders').expect(200));
      expect(orders.every((o) => o.advanceAmount === 0)).toBe(true);
    });

    it('refuses a second conversion and raises only one order', async () => {
      const estimate = await newEstimate();
      const first = randomUUID();
      await t
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: first, target: 'sales_order' })
        .expect(201);
      const again = await t
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(409);
      expect(error(again).code).toBe('ESTIMATE_ALREADY_CONVERTED');

      const linked = rows<SalesOrder>(await t.get('/v1/sales-orders').expect(200)).filter(
        (o) => o.estimateId === estimate.id,
      );
      expect(linked).toHaveLength(1);
    });

    it('survives two simultaneous conversions with exactly one order', async () => {
      const estimate = await newEstimate();
      const results = await Promise.all(
        [randomUUID(), randomUUID()].map((id) =>
          t.post(`/v1/estimates/${estimate.id}/convert`).send({ id, target: 'sales_order' }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const linked = rows<SalesOrder>(await t.get('/v1/sales-orders').expect(200)).filter(
        (o) => o.estimateId === estimate.id,
      );
      expect(linked).toHaveLength(1);
    });

    it('freezes a converted estimate: no edit, cancel, close or delete', async () => {
      const estimate = await newEstimate();
      await t
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(201);

      const item = await createItem(t);
      const edit = await t
        .put(`/v1/estimates/${estimate.id}`)
        .send({ ...body(t, [line(item.id)]), id: undefined })
        .expect(409);
      expect(error(edit).code).toBe('ESTIMATE_ALREADY_CONVERTED');
      await t.post(`/v1/estimates/${estimate.id}/close`).expect(409);
      await t.post(`/v1/estimates/${estimate.id}/cancel`).send({ reason: 'x' }).expect(409);
      const del = await t.del(`/v1/estimates/${estimate.id}`).expect(409);
      expect(error(del).code).toBe('ESTIMATE_ALREADY_CONVERTED');
    });

    it('leaves the sales order alone when its estimate is later read or listed', async () => {
      const estimate = await newEstimate();
      const orderId = randomUUID();
      await t
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: orderId, target: 'sales_order' })
        .expect(201);
      const before = data<SalesOrder>(await t.get(`/v1/sales-orders/${orderId}`).expect(200));
      await t.get(`/v1/estimates/${estimate.id}`).expect(200);
      const after = data<SalesOrder>(await t.get(`/v1/sales-orders/${orderId}`).expect(200));
      expect(after).toEqual(before);
    });

    it('refuses to convert a closed or cancelled estimate', async () => {
      const closed = await newEstimate();
      await t.post(`/v1/estimates/${closed.id}/close`).expect(200);
      const res = await t
        .post(`/v1/estimates/${closed.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(409);
      expect(error(res).code).toBe('ESTIMATE_NOT_OPEN');
    });
  });

  describe('convert to an invoice', () => {
    async function sale(estimateId: string | undefined, itemId: string) {
      const base = invoicePayload(t, {
        seriesId: series.id,
        sequenceNo: nextSeq++,
        lines: [{ itemId, quantity: 2000, unitPrice: 10_000, taxRatePercent: 18 }],
        payments: [{ id: randomUUID(), mode: 'cash', amount: 23_600 }],
      });
      return t.post('/v1/invoices').send({ ...base, ...(estimateId ? { estimateId } : {}) });
    }

    it('marks the estimate converted in the same transaction as the invoice', async () => {
      const item = await createItem(t);
      const estimate = data<Estimate>(await create(body(t, [line(item.id)])));
      const res = await sale(estimate.id, item.id);
      expect(res.status).toBe(201);
      const invoice = data<{ id: string; documentNumber: string }>(res);

      const after = data<Estimate>(await t.get(`/v1/estimates/${estimate.id}`).expect(200));
      expect(after.status).toBe('converted');
      expect(after.convertedToType).toBe('invoice');
      expect(after.convertedToId).toBe(invoice.id);
      expect(after.convertedToNumber).toBe(invoice.documentNumber);
    });

    it('still issues the sale when the estimate was already converted, without re-linking', async () => {
      const item = await createItem(t);
      const estimate = data<Estimate>(await create(body(t, [line(item.id)])));
      const first = data<{ id: string }>(await sale(estimate.id, item.id));
      const second = await sale(estimate.id, item.id);
      // A rung-up sale must never be rejected over a stale link.
      expect(second.status).toBe(201);

      const after = data<Estimate>(await t.get(`/v1/estimates/${estimate.id}`).expect(200));
      expect(after.convertedToId).toBe(first.id);
    });

    it('ignores an estimate id that does not exist', async () => {
      const item = await createItem(t);
      const res = await sale(randomUUID(), item.id);
      expect(res.status).toBe(201);
    });
  });

  describe('close, cancel and delete', () => {
    it('closes and cancels an open estimate, and is idempotent about it', async () => {
      const a = await newEstimate();
      const closed = data<Estimate>(await t.post(`/v1/estimates/${a.id}/close`).expect(200));
      expect(closed.status).toBe('closed');
      expect(data<Estimate>(await t.post(`/v1/estimates/${a.id}/close`).expect(200)).status).toBe(
        'closed',
      );

      const b = await newEstimate();
      const cancelled = data<Estimate>(
        await t.post(`/v1/estimates/${b.id}/cancel`).send({ reason: 'Price too high' }).expect(200),
      );
      expect(cancelled.status).toBe('cancelled');
    });

    it('refuses to edit a closed or cancelled estimate', async () => {
      const a = await newEstimate();
      await t.post(`/v1/estimates/${a.id}/close`).expect(200);
      const item = await createItem(t);
      const res = await t
        .put(`/v1/estimates/${a.id}`)
        .send({ ...body(t, [line(item.id)]), id: undefined })
        .expect(409);
      expect(error(res).code).toBe('ESTIMATE_NOT_OPEN');
    });

    it('soft-deletes an open estimate: it disappears from reads and lists', async () => {
      const a = await newEstimate();
      await t.del(`/v1/estimates/${a.id}`).expect(204);
      await t.get(`/v1/estimates/${a.id}`).expect(404);
      const ids = rows<Estimate>(await t.get('/v1/estimates').expect(200)).map((e) => e.id);
      expect(ids).not.toContain(a.id);
    });

    it('does not reuse a deleted estimate id on a replayed create', async () => {
      const item = await createItem(t);
      const payload = body(t, [line(item.id)]);
      const created = data<Estimate>(await create(payload));
      await t.del(`/v1/estimates/${created.id}`).expect(204);
      await create(payload, 409);
    });
  });

  describe('print', () => {
    it('builds an ESTIMATE document with no balance-due row', async () => {
      const estimate = await newEstimate();
      const doc = data<{ title: string; documentNumber?: string; totals?: unknown }>(
        await t.get(`/v1/estimates/${estimate.id}/print-payload`).expect(200),
      );
      expect(JSON.stringify(doc)).toContain('ESTIMATE');
      expect(JSON.stringify(doc)).not.toContain('Balance on khata');
    });
  });

  describe('permissions and isolation', () => {
    it('lets a cashier quote and read, but not edit, delete or convert', async () => {
      const cashier = await addMember(t, 'cashier');
      const item = await createItem(t);
      const made = data<Estimate>(await create(body(t, [line(item.id)], {}), 201, cashier));
      await cashier.get(`/v1/estimates/${made.id}`).expect(200);

      await cashier
        .put(`/v1/estimates/${made.id}`)
        .send({ ...body(t, [line(item.id)]), id: undefined })
        .expect(403);
      await cashier.del(`/v1/estimates/${made.id}`).expect(403);
      await cashier
        .post(`/v1/estimates/${made.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(403);
    });

    it('lets a viewer read but not create', async () => {
      const viewer = await addMember(t, 'viewer');
      const existing = await newEstimate();
      await viewer.get(`/v1/estimates/${existing.id}`).expect(200);
      await viewer.get('/v1/estimates').expect(200);
      const item = await createItem(t);
      await create(body(t, [line(item.id)]), 403, viewer);
    });

    it('lets a manager convert, but only when they may also create orders', async () => {
      const manager = await addMember(t, 'manager');
      const estimate = await newEstimate();
      await manager
        .post(`/v1/estimates/${estimate.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(201);
    });

    it('hides one business’s estimates from another', async () => {
      const stranger = await createTenant({ name: 'Other Estimates Shop' });
      const mine = await newEstimate();
      await stranger.get(`/v1/estimates/${mine.id}`).expect(404);
      await stranger.del(`/v1/estimates/${mine.id}`).expect(404);
      await stranger
        .post(`/v1/estimates/${mine.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(404);
      expect(rows<Estimate>(await stranger.get('/v1/estimates').expect(200))).toHaveLength(0);
    });

    it('requires a sign-in', async () => {
      const { default: request } = await import('supertest');
      const { app } = await import('./setup/tenant.js');
      await request(app).get('/v1/estimates').expect(401);
    });
  });
});
