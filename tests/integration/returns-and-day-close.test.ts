/**
 * Regressions for paths that had never run against the real application role:
 * a credit note, a debit note, and the expected-cash figure.
 *
 * Each of them failed with a database error while every unit test passed, because the
 * unit suites never reach Postgres and no integration test exercised them. The app role
 * cannot lock or update the immutable line tables, and a statement may not be handed a
 * parameter it never mentions.
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
} from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

afterAll(async () => {
  await closeOwnerClient();
  await closePool();
});

describe('returns against the real application role', () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant({ name: 'Returns Shop' });
  });

  it('issues and voids a credit note against an invoice', async () => {
    const sales = await createSeries(t, { prefix: 'RT' });
    let seq = (await leaseBlock(t, sales.id, 10)).startSeq;
    const credits = await createSeries(t, { prefix: 'CN', documentType: 'credit_note' });
    let cseq = (await leaseBlock(t, credits.id, 10)).startSeq;
    const item = await createItem(t);
    const customer = await createCustomer(t);

    const line = { itemId: item.id, quantity: 2000, unitPrice: 10_000, taxRatePercent: 18 };
    const invoice = data<{ id: string; lines: { id: string }[] }>(
      await t
        .post('/v1/invoices')
        .send(invoicePayload(t, { seriesId: sales.id, sequenceNo: seq++, customerId: customer.id, lines: [line] }))
        .expect(201),
    );

    const note = data<{ id: string; grandTotal: number }>(
      await t
        .post('/v1/credit-notes')
        .send({
          id: randomUUID(),
          originalInvoiceId: invoice.id,
          seriesId: credits.id,
          sequenceNo: cseq++,
          documentDate: today(),
          issuedAt: new Date().toISOString(),
          lines: [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, quantity: 1000 }],
          reasonCode: 'return',
          refundMode: 'khata',
        })
        .expect(201),
    );
    expect(note.grandTotal).toBe(expectedTotals([{ ...line, quantity: 1000 }]).grandTotal);

    // More than what is left to return is refused, and what was returned is counted.
    await t
      .post('/v1/credit-notes')
      .send({
        id: randomUUID(),
        originalInvoiceId: invoice.id,
        seriesId: credits.id,
        sequenceNo: cseq++,
        documentDate: today(),
        issuedAt: new Date().toISOString(),
        lines: [{ id: randomUUID(), invoiceLineId: invoice.lines[0]?.id, quantity: 1500 }],
        reasonCode: 'return',
        refundMode: 'khata',
      })
      .expect(422);

    await t.post(`/v1/credit-notes/${note.id}/void`).send({ reason: 'taken back' }).expect(200);
  });

  it('issues a debit note against a purchase bill', async () => {
    const item = await createItem(t);
    const supplierId = randomUUID();
    await t.post('/v1/suppliers').send({ id: supplierId, name: 'Wholesale Co' }).expect(201);

    const bill = data<{ id: string; lines: { id: string }[] }>(
      await t
        .post('/v1/purchase-bills')
        .send({
          id: randomUUID(),
          outletId: t.outletId,
          supplierId,
          documentDate: today(),
          supplierInvoiceNo: `WS-${randomUUID().slice(0, 6)}`,
          supplierInvoiceDate: today(),
          receivedAt: new Date().toISOString(),
          lines: [
            { id: randomUUID(), itemId: item.id, quantity: 5000, unitPrice: 6_000, taxRatePercent: 18 },
          ],
        })
        .expect(201),
    );

    await t
      .post('/v1/debit-notes')
      .send({
        id: randomUUID(),
        purchaseBillId: bill.id,
        documentDate: today(),
        reasonCode: 'return',
        lines: [{ id: randomUUID(), purchaseBillLineId: bill.lines[0]?.id, quantity: 2000 }],
        issuedAt: new Date().toISOString(),
      })
      .expect(201);
  });

  it('answers the expected cash for the day', async () => {
    const res = await t.get(`/v1/day-close/expected?outletId=${t.outletId}`).expect(200);
    const figures = data<{ openingFloat: number; expectedCash: number }>(res);
    expect(typeof figures.expectedCash).toBe('number');
  });
});
