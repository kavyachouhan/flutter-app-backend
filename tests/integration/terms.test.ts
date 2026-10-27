/**
 * Reusable Terms & Conditions: the master CRUD, filtering by document type,
 * and the guarantee that a document keeps the text it was issued with.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import {
  createItem,
  createSeries,
  invoicePayload,
  leaseBlock,
  type SeriesFixture,
} from './setup/fixtures.js';
import { data, error, rows } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

interface Terms {
  id: string;
  title: string;
  description: string;
  applicableFor: string[];
}

interface Invoice {
  id: string;
  termsId: string | null;
  termsSnapshot: { title: string; description: string } | null;
}

describe('terms and conditions', () => {
  let t: TenantFixture;
  let series: SeriesFixture;
  let nextSeq = 0;

  async function createTerms(
    title: string,
    applicableFor: string[],
    description = `${title} text`,
  ): Promise<Terms> {
    return data<Terms>(
      await t
        .post('/v1/terms')
        .send({ id: randomUUID(), title, description, applicableFor })
        .expect(201),
    );
  }

  async function issueSale(status: number, termsId?: string | null) {
    const item = await createItem(t);
    return t
      .post('/v1/invoices')
      .send({
        ...invoicePayload(t, {
          seriesId: series.id,
          sequenceNo: nextSeq++,
          lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
          payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
        }),
        ...(termsId === undefined ? {} : { termsId }),
      })
      .expect(status);
  }

  beforeAll(async () => {
    t = await createTenant({ name: 'Terms Shop' });
    series = await createSeries(t, { prefix: 'TNC' });
    nextSeq = (await leaseBlock(t, series.id, 20)).startSeq;
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('creates, reads, edits and deletes terms', async () => {
    const created = await createTerms('Standard', ['sale', 'purchase']);
    expect(created.applicableFor).toEqual(['sale', 'purchase']);

    // A retried create returns the same record rather than a second one.
    const retry = data<Terms>(
      await t
        .post('/v1/terms')
        .send({
          id: created.id,
          title: 'Standard',
          description: 'Standard text',
          applicableFor: ['sale', 'purchase'],
        })
        .expect(201),
    );
    expect(retry.id).toBe(created.id);

    const edited = data<Terms>(
      await t
        .patch(`/v1/terms/${created.id}`)
        .send({ description: 'Updated text', applicableFor: ['sale'] })
        .expect(200),
    );
    expect(edited.description).toBe('Updated text');
    expect(edited.applicableFor).toEqual(['sale']);

    await t.del(`/v1/terms/${created.id}`).expect(204);
    await t.get(`/v1/terms/${created.id}`).expect(404);
  });

  it('lists only terms applicable to the requested document type', async () => {
    const saleOnly = await createTerms('Only sales', ['sale']);
    const poOnly = await createTerms('Only orders', ['purchase_order']);

    const forSale = rows<Terms>(await t.get('/v1/terms?applicableFor=sale').expect(200));
    expect(forSale.map((x) => x.id)).toContain(saleOnly.id);
    expect(forSale.map((x) => x.id)).not.toContain(poOnly.id);

    const forOrders = rows<Terms>(
      await t.get('/v1/terms?applicableFor=purchase_order').expect(200),
    );
    expect(forOrders.map((x) => x.id)).toContain(poOnly.id);
    expect(forOrders.map((x) => x.id)).not.toContain(saleOnly.id);
  });

  it('rejects invalid input', async () => {
    const base = { id: randomUUID(), title: 'x', description: 'y', applicableFor: ['sale'] };
    await t
      .post('/v1/terms')
      .send({ ...base, title: '   ' })
      .expect(400);
    await t
      .post('/v1/terms')
      .send({ ...base, description: '' })
      .expect(400);
    await t
      .post('/v1/terms')
      .send({ ...base, applicableFor: [] })
      .expect(400);
    await t
      .post('/v1/terms')
      .send({ ...base, applicableFor: ['refund'] })
      .expect(400);
    await t
      .post('/v1/terms')
      .send({ ...base, title: 'x'.repeat(121) })
      .expect(400);
  });

  it('issues a sale with terms and stores a snapshot of their text', async () => {
    const terms = await createTerms('Sale terms', ['sale'], 'No returns after 7 days.');
    const invoice = data<Invoice>(await issueSale(201, terms.id));

    expect(invoice.termsId).toBe(terms.id);
    expect(invoice.termsSnapshot).toEqual({
      title: 'Sale terms',
      description: 'No returns after 7 days.',
    });

    const fetched = data<Invoice>(await t.get(`/v1/invoices/${invoice.id}`).expect(200));
    expect(fetched.termsId).toBe(terms.id);
  });

  it('keeps the issued text after the terms are edited or deleted', async () => {
    const terms = await createTerms('Changing', ['sale'], 'Original wording.');
    const invoice = data<Invoice>(await issueSale(201, terms.id));

    await t.patch(`/v1/terms/${terms.id}`).send({ description: 'New wording.' }).expect(200);
    await t.del(`/v1/terms/${terms.id}`).expect(204);

    const fetched = data<Invoice>(await t.get(`/v1/invoices/${invoice.id}`).expect(200));
    expect(fetched.termsSnapshot?.description).toBe('Original wording.');
  });

  it('issues a sale with no terms, as before', async () => {
    const withoutField = data<Invoice>(await issueSale(201));
    expect(withoutField.termsId).toBeNull();
    expect(withoutField.termsSnapshot).toBeNull();

    const explicitNull = data<Invoice>(await issueSale(201, null));
    expect(explicitNull.termsId).toBeNull();
  });

  it('refuses terms that do not apply to the document or do not exist', async () => {
    const purchaseOnly = await createTerms('Purchases only', ['purchase']);
    const res = await issueSale(422, purchaseOnly.id);
    expect(error(res).message).toMatch(/not applicable/i);

    await issueSale(404, randomUUID());
  });

  it('does not show one shop another shop’s terms', async () => {
    const mine = await createTerms('Private', ['sale']);
    const other = await createTenant({ name: 'Other Terms Shop' });
    await other.get(`/v1/terms/${mine.id}`).expect(404);
    const theirs = rows<Terms>(await other.get('/v1/terms').expect(200));
    expect(theirs.map((x) => x.id)).not.toContain(mine.id);
  });
});
