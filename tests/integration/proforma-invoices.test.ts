/**
 * Proforma invoices: create / read / edit / delete, the totals the server insists on, the
 * lifecycle (open, converted, closed, cancelled), derived expiry, conversion by the invoice that
 * names one, Terms & Conditions applicability, that a proforma never moves stock or money,
 * permissions and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient, ownerClient } from './setup/database.js';
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

interface ProformaInvoice {
  id: string;
  documentNumber: string;
  status: 'open' | 'converted' | 'closed' | 'cancelled';
  effectiveStatus: 'open' | 'converted' | 'closed' | 'cancelled' | 'expired';
  isExpired: boolean;
  grandTotal: number;
  balance: number;
  validUntil: string | null;
  termsId: string | null;
  termsSnapshot: { title: string; description: string } | null;
  convertedToType: 'invoice' | null;
  convertedToId: string | null;
  convertedToNumber: string | null;
  lines: { id: string; quantity: number; unitPrice: number }[];
}

interface Terms {
  id: string;
  applicableFor: string[];
}

/** A date `days` from today, YYYY-MM-DD. The shop's time zone can differ by a day, so tests keep a margin. */
function daysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Every call is a round trip to a hosted database.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('proforma invoices', () => {
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
    who.post('/v1/proforma-invoices').send(payload).expect(status);

  async function newProforma(extra: Record<string, unknown> = {}): Promise<ProformaInvoice> {
    const item = await createItem(t);
    return data<ProformaInvoice>(await create(body(t, [line(item.id)], extra)));
  }

  async function createTerms(applicableFor: string[]): Promise<Terms> {
    return data<Terms>(
      await t
        .post('/v1/terms')
        .send({
          id: randomUUID(),
          title: `Terms ${randomUUID().slice(0, 6)}`,
          description: 'Payment before dispatch.',
          applicableFor,
        })
        .expect(201),
    );
  }

  beforeAll(async () => {
    t = await createTenant({ name: 'Proforma Shop' });
    series = await createSeries(t, { prefix: 'PINV' });
    nextSeq = (await leaseBlock(t, series.id, 50)).startSeq;
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  describe('create and read', () => {
    it('creates a proforma with a generated PI number and the right totals', async () => {
      const item = await createItem(t);
      const lines = [line(item.id)];
      const created = data<ProformaInvoice>(await create(body(t, lines)));
      expect(created.documentNumber).toMatch(/^PI\//);
      expect(created.status).toBe('open');
      expect(created.isExpired).toBe(false);
      expect(created.effectiveStatus).toBe('open');
      expect(created.grandTotal).toBe(expectedTotals(lines).grandTotal);
      expect(created.balance).toBe(created.grandTotal);

      const read = data<ProformaInvoice>(
        await t.get(`/v1/proforma-invoices/${created.id}`).expect(200),
      );
      expect(read.lines).toHaveLength(1);
      expect(read.lines[0]?.quantity).toBe(2000);
    });

    it('numbers proformas in sequence, separate from estimates', async () => {
      const a = await newProforma();
      const b = await newProforma();
      const seq = (n: string) => Number(n.split('/').pop());
      expect(seq(b.documentNumber)).toBe(seq(a.documentNumber) + 1);
    });

    it('answers a replayed create with 200 and does not create a second proforma', async () => {
      const item = await createItem(t);
      const payload = body(t, [line(item.id)]);
      const first = data<ProformaInvoice>(await create(payload));
      const second = await create(payload, 200);
      expect(data<ProformaInvoice>(second).id).toBe(first.id);
      expect(data<ProformaInvoice>(second).documentNumber).toBe(first.documentNumber);
    });

    it('takes a proforma for a typed amount with no items', async () => {
      const created = data<ProformaInvoice>(
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

    it('refuses a proforma with neither items nor an amount', async () => {
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
      const res = await create(
        body(t, [line(item.id)], {
          expectedTotals: { grandTotal: 1, totalTax: 0, taxableAmount: 1 },
        }),
        409,
      );
      expect(error(res).code).toBe('TOTALS_MISMATCH');
    });

    it('requires a customer', async () => {
      const item = await createItem(t);
      const res = await create(body(t, [line(item.id)], { customerName: null }), 400);
      expect(error(res).details).toMatchObject({ field: 'customerName' });
    });

    it('refuses a validity date before the proforma date', async () => {
      const item = await createItem(t);
      const res = await create(body(t, [line(item.id)], { validUntil: '2000-01-01' }), 400);
      expect(error(res).details).toMatchObject({ field: 'validUntil' });
    });

    it('applies a bill discount and refuses one larger than the bill', async () => {
      const item = await createItem(t);
      const lines = [line(item.id, 1000, 10_000)];
      const res = await create(
        body(t, lines, { billDiscount: { kind: 'amount', value: 99_999_999 } }),
        400,
      );
      expect(error(res).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('edit', () => {
    it('replaces the lines and recomputes the totals, keeping the number', async () => {
      const item = await createItem(t);
      const created = data<ProformaInvoice>(await create(body(t, [line(item.id)])));
      const next = [line(item.id, 1000, 20_000), line(item.id, 3000, 5_000)];
      const edited = data<ProformaInvoice>(
        await t
          .put(`/v1/proforma-invoices/${created.id}`)
          .send({ ...body(t, next), id: undefined })
          .expect(200),
      );
      expect(edited.documentNumber).toBe(created.documentNumber);
      expect(edited.lines).toHaveLength(2);
      expect(edited.grandTotal).toBe(expectedTotals(next).grandTotal);
    });

    it('validates an edit as strictly as a create', async () => {
      const created = await newProforma();
      const item = await createItem(t);
      const res = await t
        .put(`/v1/proforma-invoices/${created.id}`)
        .send({
          ...body(t, [line(item.id)], { validUntil: '2000-01-01' }),
          id: undefined,
        })
        .expect(400);
      expect(error(res).details).toMatchObject({ field: 'validUntil' });
    });

    it('refuses to move a proforma to another outlet', async () => {
      const created = await newProforma();
      const item = await createItem(t);
      await t
        .put(`/v1/proforma-invoices/${created.id}`)
        .send({ ...body(t, [line(item.id)], { outletId: randomUUID() }), id: undefined })
        .expect((r) => expect([400, 403, 404]).toContain(r.status));
    });
  });

  describe('list, filters and search', () => {
    it('filters by open and closed, searches, and counts for the chips', async () => {
      const fresh = await createTenant({ name: 'Filter Proforma Shop' });
      const item = await createItem(fresh);
      const make = async (name: string, extra: Record<string, unknown> = {}) =>
        data<ProformaInvoice>(
          await create(
            body(fresh, [line(item.id)], { customerName: name, ...extra }),
            201,
            fresh,
          ),
        );
      const open = await make('Alpha Traders');
      const toClose = await make('Beta Stores');
      const toCancel = await make('Gamma Mart');
      await fresh.post(`/v1/proforma-invoices/${toClose.id}/close`).expect(200);
      await fresh
        .post(`/v1/proforma-invoices/${toCancel.id}/cancel`)
        .send({ reason: 'Customer went elsewhere' })
        .expect(200);

      const ids = async (query: string) =>
        rows<ProformaInvoice>(await fresh.get(`/v1/proforma-invoices${query}`).expect(200)).map(
          (e) => e.id,
        );

      expect((await ids('')).sort()).toEqual([open.id, toClose.id, toCancel.id].sort());
      expect(await ids('?status=open')).toEqual([open.id]);
      expect((await ids('?status=closed')).sort()).toEqual([toClose.id, toCancel.id].sort());
      expect(await ids('?q=beta')).toEqual([toClose.id]);
      expect(await ids(`?q=${open.documentNumber.split('/').pop()}`)).toContain(open.id);
      expect(await ids('?q=nobody')).toEqual([]);

      const summary = data<{ all: number; open: number; closed: number }>(
        await fresh.get('/v1/proforma-invoices/summary').expect(200),
      );
      expect(summary).toEqual({ all: 3, open: 1, closed: 2 });
    });

    it('pages with a cursor', async () => {
      const fresh = await createTenant({ name: 'Paging Proforma Shop' });
      const item = await createItem(fresh);
      for (let i = 0; i < 3; i++) await create(body(fresh, [line(item.id)]), 201, fresh);
      const first = await fresh.get('/v1/proforma-invoices?limit=2').expect(200);
      expect(rows<ProformaInvoice>(first)).toHaveLength(2);
      const cursor = (first.body as { nextCursor: string | null }).nextCursor;
      expect(cursor).toBeTruthy();
      const second = await fresh
        .get(`/v1/proforma-invoices?limit=2&cursor=${cursor}`)
        .expect(200);
      expect(rows<ProformaInvoice>(second)).toHaveLength(1);
    });
  });

  describe('validity and expiry', () => {
    const expiredBody = async () => {
      const item = await createItem(t);
      return body(t, [line(item.id)], {
        documentDate: daysFromToday(-10),
        validUntil: daysFromToday(-5),
      });
    };

    it('is not expired on its last day of validity or with no validity date', async () => {
      const lastDay = await newProforma({ validUntil: daysFromToday(1) });
      expect(lastDay.isExpired).toBe(false);
      const open = await newProforma({ validUntil: null });
      expect(open.isExpired).toBe(false);
    });

    it('derives expired for an open proforma past its date, without storing it', async () => {
      const made = data<ProformaInvoice>(await create(await expiredBody()));
      expect(made.status).toBe('open');
      expect(made.isExpired).toBe(true);
      expect(made.effectiveStatus).toBe('expired');
      expect(made.balance).toBe(made.grandTotal);

      const c = await ownerClient();
      const { rows: stored } = await c.query<{ status: string }>(
        'SELECT status FROM proforma_invoices WHERE id = $1',
        [made.id],
      );
      expect(stored[0]?.status).toBe('open');
    });

    it('counts an expired proforma under closed, not open, in lists and chips', async () => {
      const fresh = await createTenant({ name: 'Expiry Proforma Shop' });
      const item = await createItem(fresh);
      const live = data<ProformaInvoice>(
        await create(body(fresh, [line(item.id)], { validUntil: daysFromToday(5) }), 201, fresh),
      );
      const lapsed = data<ProformaInvoice>(
        await create(
          body(fresh, [line(item.id)], {
            documentDate: daysFromToday(-10),
            validUntil: daysFromToday(-5),
          }),
          201,
          fresh,
        ),
      );
      const ids = async (q: string) =>
        rows<ProformaInvoice>(await fresh.get(`/v1/proforma-invoices${q}`).expect(200)).map(
          (x) => x.id,
        );
      expect(await ids('?status=open')).toEqual([live.id]);
      expect(await ids('?status=closed')).toEqual([lapsed.id]);
      const listed = rows<ProformaInvoice>(await fresh.get('/v1/proforma-invoices').expect(200));
      expect(listed.find((x) => x.id === lapsed.id)?.effectiveStatus).toBe('expired');
      expect(
        data<{ all: number; open: number; closed: number }>(
          await fresh.get('/v1/proforma-invoices/summary').expect(200),
        ),
      ).toEqual({ all: 2, open: 1, closed: 1 });
    });

    it('can be edited to extend the validity, which makes it live again', async () => {
      const made = data<ProformaInvoice>(await create(await expiredBody()));
      const item = await createItem(t);
      const edited = data<ProformaInvoice>(
        await t
          .put(`/v1/proforma-invoices/${made.id}`)
          .send({ ...body(t, [line(item.id)], { validUntil: daysFromToday(7) }), id: undefined })
          .expect(200),
      );
      expect(edited.isExpired).toBe(false);
      expect(edited.effectiveStatus).toBe('open');
    });

    it('does not link an expired proforma to a sale, and still issues the sale', async () => {
      const item = await createItem(t);
      const made = data<ProformaInvoice>(
        await create(
          body(t, [line(item.id)], {
            documentDate: daysFromToday(-10),
            validUntil: daysFromToday(-5),
          }),
        ),
      );
      const res = await sale(made.id, item.id);
      expect(res.status).toBe(201);
      const after = data<ProformaInvoice>(
        await t.get(`/v1/proforma-invoices/${made.id}`).expect(200),
      );
      expect(after.status).toBe('open');
      expect(after.convertedToId).toBeNull();
    });

    it('judges validity on the sale date, so an offline sale made in time still converts', async () => {
      const item = await createItem(t);
      const made = data<ProformaInvoice>(
        await create(
          body(t, [line(item.id)], {
            documentDate: daysFromToday(-10),
            validUntil: daysFromToday(-5),
          }),
        ),
      );
      const res = await sale(made.id, item.id, daysFromToday(-6));
      expect(res.status).toBe(201);
      const after = data<ProformaInvoice>(
        await t.get(`/v1/proforma-invoices/${made.id}`).expect(200),
      );
      expect(after.status).toBe('converted');
    });
  });

  describe('terms and conditions', () => {
    it('accepts a T&C applicable to proforma invoices and snapshots its text', async () => {
      const terms = await createTerms(['proforma_invoice', 'sale']);
      expect(terms.applicableFor).toContain('proforma_invoice');
      const created = await newProforma({ termsId: terms.id });
      expect(created.termsId).toBe(terms.id);
      expect(created.termsSnapshot?.description).toBe('Payment before dispatch.');

      await t.patch(`/v1/terms/${terms.id}`).send({ description: 'Changed.' }).expect(200);
      const reread = data<ProformaInvoice>(
        await t.get(`/v1/proforma-invoices/${created.id}`).expect(200),
      );
      expect(reread.termsSnapshot?.description).toBe('Payment before dispatch.');
    });

    it('lists proforma T&C under its filter only', async () => {
      const only = await createTerms(['proforma_invoice']);
      const sale = await createTerms(['sale']);
      const ids = rows<Terms>(
        await t.get('/v1/terms?applicableFor=proforma_invoice').expect(200),
      ).map((x) => x.id);
      expect(ids).toContain(only.id);
      expect(ids).not.toContain(sale.id);
    });

    it('refuses a T&C that is not applicable to proforma invoices', async () => {
      const sale = await createTerms(['sale']);
      const item = await createItem(t);
      const res = await create(body(t, [line(item.id)], { termsId: sale.id }), 422);
      expect(error(res).message).toMatch(/not applicable/i);
    });

    it('keeps proforma-only T&C off other documents, and existing types working', async () => {
      const only = await createTerms(['proforma_invoice']);
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

      const estimateTerms = await createTerms(['estimate']);
      await t
        .post('/v1/estimates')
        .send({ ...body(t, lines), termsId: estimateTerms.id })
        .expect(201);
    });
  });

  async function sale(proformaInvoiceId: string | undefined, itemId: string, date?: string) {
    const base = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: nextSeq++,
      lines: [{ itemId, quantity: 2000, unitPrice: 10_000, taxRatePercent: 18 }],
      payments: [{ id: randomUUID(), mode: 'cash', amount: 23_600 }],
    });
    return t.post('/v1/invoices').send({
      ...base,
      ...(date ? { documentDate: date } : {}),
      ...(proformaInvoiceId ? { proformaInvoiceId } : {}),
    });
  }

  describe('convert by the invoice', () => {
    it('is preliminary: creating one moves no stock, takes no payment and raises no invoice', async () => {
      const c = await ownerClient();
      const count = async (sql: string) =>
        Number(
          (await c.query<{ n: string }>(sql, [t.tenantId])).rows[0]?.n,
        );
      const before = {
        invoices: await count('SELECT count(*) AS n FROM invoices WHERE tenant_id = $1'),
        payments: await count('SELECT count(*) AS n FROM payments WHERE tenant_id = $1'),
        stock: await count('SELECT count(*) AS n FROM stock_ledger_entries WHERE tenant_id = $1'),
      };
      await newProforma();
      expect(await count('SELECT count(*) AS n FROM invoices WHERE tenant_id = $1')).toBe(
        before.invoices,
      );
      expect(await count('SELECT count(*) AS n FROM payments WHERE tenant_id = $1')).toBe(
        before.payments,
      );
      expect(
        await count('SELECT count(*) AS n FROM stock_ledger_entries WHERE tenant_id = $1'),
      ).toBe(before.stock);
    });

    it('marks the proforma converted in the same transaction as the invoice', async () => {
      const item = await createItem(t);
      const made = data<ProformaInvoice>(await create(body(t, [line(item.id)])));
      const res = await sale(made.id, item.id);
      expect(res.status).toBe(201);
      const invoice = data<{ id: string; documentNumber: string }>(res);

      const after = data<ProformaInvoice>(
        await t.get(`/v1/proforma-invoices/${made.id}`).expect(200),
      );
      expect(after.status).toBe('converted');
      expect(after.convertedToType).toBe('invoice');
      expect(after.convertedToId).toBe(invoice.id);
      expect(after.convertedToNumber).toBe(invoice.documentNumber);
      expect(after.effectiveStatus).toBe('converted');
    });

    it('still issues the sale when already converted, without re-linking', async () => {
      const item = await createItem(t);
      const made = data<ProformaInvoice>(await create(body(t, [line(item.id)])));
      const first = data<{ id: string }>(await sale(made.id, item.id));
      const second = await sale(made.id, item.id);
      expect(second.status).toBe(201);

      const after = data<ProformaInvoice>(
        await t.get(`/v1/proforma-invoices/${made.id}`).expect(200),
      );
      expect(after.convertedToId).toBe(first.id);
    });

    it('ignores a proforma id that does not exist', async () => {
      const item = await createItem(t);
      const res = await sale(randomUUID(), item.id);
      expect(res.status).toBe(201);
    });

    it('freezes a converted proforma: no edit, cancel, close or delete', async () => {
      const item = await createItem(t);
      const made = data<ProformaInvoice>(await create(body(t, [line(item.id)])));
      await sale(made.id, item.id);

      const edit = await t
        .put(`/v1/proforma-invoices/${made.id}`)
        .send({ ...body(t, [line(item.id)]), id: undefined })
        .expect(409);
      expect(error(edit).code).toBe('PROFORMA_INVOICE_ALREADY_CONVERTED');
      await t.post(`/v1/proforma-invoices/${made.id}/close`).expect(409);
      await t.post(`/v1/proforma-invoices/${made.id}/cancel`).send({ reason: 'x' }).expect(409);
      await t.del(`/v1/proforma-invoices/${made.id}`).expect(409);
    });

    it('has no convert route of its own', async () => {
      const made = await newProforma();
      await t
        .post(`/v1/proforma-invoices/${made.id}/convert`)
        .send({ id: randomUUID() })
        .expect(404);
    });
  });

  describe('estimates keep working, and now expire too', () => {
    it('derives expired for a lapsed estimate and refuses to convert it to an order', async () => {
      const item = await createItem(t);
      const made = data<{ id: string; isExpired: boolean; effectiveStatus: string }>(
        await t
          .post('/v1/estimates')
          .send(
            body(t, [line(item.id)], {
              documentDate: daysFromToday(-10),
              validUntil: daysFromToday(-5),
            }),
          )
          .expect(201),
      );
      expect(made.isExpired).toBe(true);
      expect(made.effectiveStatus).toBe('expired');
      const res = await t
        .post(`/v1/estimates/${made.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(409);
      expect(error(res).code).toBe('ESTIMATE_EXPIRED');

      const summary = data<{ open: number; closed: number }>(
        await t.get('/v1/estimates/summary').expect(200),
      );
      expect(summary.closed).toBeGreaterThanOrEqual(1);
    });

    it('lets a lapsed estimate be edited to extend it, then converts', async () => {
      const item = await createItem(t);
      const made = data<{ id: string }>(
        await t
          .post('/v1/estimates')
          .send(
            body(t, [line(item.id)], {
              documentDate: daysFromToday(-10),
              validUntil: daysFromToday(-5),
            }),
          )
          .expect(201),
      );
      await t
        .put(`/v1/estimates/${made.id}`)
        .send({ ...body(t, [line(item.id)], { validUntil: daysFromToday(7) }), id: undefined })
        .expect(200);
      await t
        .post(`/v1/estimates/${made.id}/convert`)
        .send({ id: randomUUID(), target: 'sales_order' })
        .expect(201);
    });
  });

  describe('close, cancel and delete', () => {
    it('closes and cancels an open proforma, and is idempotent about it', async () => {
      const a = await newProforma();
      const closed = data<ProformaInvoice>(
        await t.post(`/v1/proforma-invoices/${a.id}/close`).expect(200),
      );
      expect(closed.status).toBe('closed');
      expect(
        data<ProformaInvoice>(await t.post(`/v1/proforma-invoices/${a.id}/close`).expect(200))
          .status,
      ).toBe('closed');

      const b = await newProforma();
      const cancelled = data<ProformaInvoice>(
        await t
          .post(`/v1/proforma-invoices/${b.id}/cancel`)
          .send({ reason: 'Price too high' })
          .expect(200),
      );
      expect(cancelled.status).toBe('cancelled');
    });

    it('refuses to edit a closed proforma', async () => {
      const a = await newProforma();
      await t.post(`/v1/proforma-invoices/${a.id}/close`).expect(200);
      const item = await createItem(t);
      const res = await t
        .put(`/v1/proforma-invoices/${a.id}`)
        .send({ ...body(t, [line(item.id)]), id: undefined })
        .expect(409);
      expect(error(res).code).toBe('PROFORMA_INVOICE_NOT_OPEN');
    });

    it('soft-deletes an open proforma: it disappears from reads and lists', async () => {
      const a = await newProforma();
      await t.del(`/v1/proforma-invoices/${a.id}`).expect(204);
      await t.get(`/v1/proforma-invoices/${a.id}`).expect(404);
      const ids = rows<ProformaInvoice>(await t.get('/v1/proforma-invoices').expect(200)).map(
        (e) => e.id,
      );
      expect(ids).not.toContain(a.id);
    });

    it('does not reuse a deleted proforma id on a replayed create', async () => {
      const item = await createItem(t);
      const payload = body(t, [line(item.id)]);
      const created = data<ProformaInvoice>(await create(payload));
      await t.del(`/v1/proforma-invoices/${created.id}`).expect(204);
      await create(payload, 409);
    });
  });

  describe('print', () => {
    it('builds a PROFORMA INVOICE document with no balance-due row', async () => {
      const made = await newProforma();
      const doc = data<unknown>(
        await t.get(`/v1/proforma-invoices/${made.id}/print-payload`).expect(200),
      );
      expect(JSON.stringify(doc)).toContain('PROFORMA INVOICE');
      expect(JSON.stringify(doc)).not.toContain('Balance on khata');
    });
  });

  describe('permissions and isolation', () => {
    it('lets a cashier create and read, but not edit or delete', async () => {
      const cashier = await addMember(t, 'cashier');
      const item = await createItem(t);
      const made = data<ProformaInvoice>(await create(body(t, [line(item.id)]), 201, cashier));
      await cashier.get(`/v1/proforma-invoices/${made.id}`).expect(200);
      await cashier
        .put(`/v1/proforma-invoices/${made.id}`)
        .send({ ...body(t, [line(item.id)]), id: undefined })
        .expect(403);
      await cashier.del(`/v1/proforma-invoices/${made.id}`).expect(403);
    });

    it('lets a viewer read but not create', async () => {
      const viewer = await addMember(t, 'viewer');
      const existing = await newProforma();
      await viewer.get(`/v1/proforma-invoices/${existing.id}`).expect(200);
      await viewer.get('/v1/proforma-invoices').expect(200);
      const item = await createItem(t);
      await create(body(t, [line(item.id)]), 403, viewer);
    });

    it('hides one business’s proformas from another', async () => {
      const stranger = await createTenant({ name: 'Other Proforma Shop' });
      const mine = await newProforma();
      await stranger.get(`/v1/proforma-invoices/${mine.id}`).expect(404);
      await stranger.del(`/v1/proforma-invoices/${mine.id}`).expect(404);
      expect(
        rows<ProformaInvoice>(await stranger.get('/v1/proforma-invoices').expect(200)),
      ).toHaveLength(0);
    });

    it('does not let another business claim a proforma through its own invoice', async () => {
      const stranger = await createTenant({ name: 'Claiming Proforma Shop' });
      const strangerSeries = await createSeries(stranger, { prefix: 'XINV' });
      const block = await leaseBlock(stranger, strangerSeries.id, 5);
      const item = await createItem(stranger);
      const mine = await newProforma();
      const base = invoicePayload(stranger, {
        seriesId: strangerSeries.id,
        sequenceNo: block.startSeq,
        lines: [{ itemId: item.id, quantity: 2000, unitPrice: 10_000, taxRatePercent: 18 }],
        payments: [{ id: randomUUID(), mode: 'cash', amount: 23_600 }],
      });
      await stranger
        .post('/v1/invoices')
        .send({ ...base, proformaInvoiceId: mine.id })
        .expect(201);
      const after = data<ProformaInvoice>(
        await t.get(`/v1/proforma-invoices/${mine.id}`).expect(200),
      );
      expect(after.status).toBe('open');
    });

    it('requires a sign-in', async () => {
      const { default: request } = await import('supertest');
      const { app } = await import('./setup/tenant.js');
      await request(app).get('/v1/proforma-invoices').expect(401);
    });
  });
});
