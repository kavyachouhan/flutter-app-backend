/**
 * Idempotency keys for pushed operations: a repeat of an operation (a reply lost in transit, a
 * retry after a crash, two copies arriving together) must be answered from the first result and
 * must never run the effects a second time.
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
} from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { runWithContext } from '../../src/lib/context.js';
import { purgeExpiredKeys } from '../../src/modules/sync/operation-keys.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface OpResult {
  opId: string;
  status: 'applied' | 'replayed' | 'rejected';
  id?: string;
  serverSeq?: number;
  retryable?: boolean;
  error?: { code: string; message: string };
}

async function push(
  who: TenantFixture,
  opId: string,
  type: string,
  payload: unknown,
): Promise<OpResult> {
  const res = await who
    .post('/v1/sync/push')
    .send({ operations: [{ opId, type, payload }] })
    .expect(200);
  return data<{ results: OpResult[] }>(res).results[0]!;
}

describe('idempotency keys on pushed operations', () => {
  let t: TenantFixture;
  let seriesId: string;
  let nextSeq: number;
  let itemId: string;

  const printCount = async (invoiceId: string) =>
    data<{ printCount: number }>(await t.get(`/v1/invoices/${invoiceId}`).expect(200)).printCount;

  const keyRows = async (opId: string) =>
    (
      await (await ownerClient()).query('SELECT 1 FROM operation_keys WHERE op_id = $1', [opId])
    ).rowCount;

  /** An invoice issued through push, so its print and void operations have something to act on. */
  const newInvoice = async (): Promise<string> => {
    const lines = [{ itemId, quantity: 1000, unitPrice: 5_000, taxRatePercent: 5 }];
    const payload = invoicePayload(t, {
      seriesId,
      sequenceNo: nextSeq++,
      lines,
      // Paid in full in cash: an unpaid bill would need a customer.
      payments: [{ id: randomUUID(), mode: 'cash', amount: expectedTotals(lines).grandTotal }],
    });
    const made = await push(t, randomUUID(), 'invoice.create', payload);
    expect(made, JSON.stringify(made)).toMatchObject({ status: 'applied' });
    return payload.id;
  };

  beforeAll(async () => {
    t = await createTenant({ name: 'Idempotency Shop' });
    itemId = (await createItem(t, { trackStock: false })).id;
    const series = await createSeries(t, { prefix: 'IDEM' });
    const block = await leaseBlock(t, series.id, 60);
    seriesId = series.id;
    nextSeq = block.startSeq;
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('answers a repeat as replayed, and counts a print once', async () => {
    const invoiceId = await newInvoice();
    const opId = randomUUID();

    const first = await push(t, opId, 'invoice.printed', { id: invoiceId });
    expect(first.status).toBe('applied');
    expect(await printCount(invoiceId)).toBe(1);

    const again = await push(t, opId, 'invoice.printed', { id: invoiceId });
    expect(again.status).toBe('replayed');
    expect(again.id).toBe(invoiceId);
    expect(again.serverSeq).toBe(first.serverSeq);
    expect(await printCount(invoiceId)).toBe(1);

    // A deliberate reprint is a new operation, so it counts.
    const reprint = await push(t, randomUUID(), 'invoice.printed', { id: invoiceId });
    expect(reprint.status).toBe('applied');
    expect(await printCount(invoiceId)).toBe(2);
  });

  it('reports a repeated cancellation as replayed, not applied', async () => {
    const invoiceId = await newInvoice();
    const opId = randomUUID();
    expect((await push(t, opId, 'invoice.void', { id: invoiceId, reason: 'wrong bill' })).status).toBe(
      'applied',
    );
    expect((await push(t, opId, 'invoice.void', { id: invoiceId, reason: 'wrong bill' })).status).toBe(
      'replayed',
    );
  });

  it('two copies arriving together apply once', async () => {
    const invoiceId = await newInvoice();
    const opId = randomUUID();
    const [a, b] = await Promise.all([
      push(t, opId, 'invoice.printed', { id: invoiceId }),
      push(t, opId, 'invoice.printed', { id: invoiceId }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'replayed']);
    expect(await printCount(invoiceId)).toBe(1);
  });

  it('refuses an opId reused for a different operation', async () => {
    const customerId = randomUUID();
    await push(t, randomUUID(), 'customer.create', { id: customerId, name: 'Asha' });
    const opId = randomUUID();
    expect(
      (await push(t, opId, 'customer.update', { id: customerId, patch: { name: 'Asha K' } })).status,
    ).toBe('applied');

    const reused = await push(t, opId, 'customer.update', {
      id: customerId,
      patch: { name: 'Someone Else' },
    });
    expect(reused.status).toBe('rejected');
    expect(reused.error?.code).toBe('OPERATION_KEY_REUSED');
    expect(reused.retryable).toBe(false);

    const row = data<{ name: string }>(await t.get(`/v1/customers/${customerId}`).expect(200));
    expect(row.name).toBe('Asha K');
  });

  it('a rolled-back operation leaves no key, so the same opId can succeed later', async () => {
    const customerId = randomUUID();
    const opId = randomUUID();

    const early = await push(t, opId, 'customer.update', { id: customerId, patch: { name: 'Early' } });
    expect(early.status).toBe('rejected');
    expect(await keyRows(opId)).toBe(0);

    await push(t, randomUUID(), 'customer.create', { id: customerId, name: 'Now Exists' });
    const later = await push(t, opId, 'customer.update', { id: customerId, patch: { name: 'Early' } });
    expect(later.status).toBe('applied');
    expect(await keyRows(opId)).toBe(1);
  });

  it('keeps keys apart between businesses', async () => {
    const other = await createTenant({ name: 'Other Idempotency Shop' });
    const opId = randomUUID();
    const mine = await push(t, opId, 'customer.create', { id: randomUUID(), name: 'Mine' });
    const theirs = await push(other, opId, 'customer.create', { id: randomUUID(), name: 'Theirs' });
    expect(mine.status).toBe('applied');
    expect(theirs.status).toBe('applied');
  });

  it('purges only expired keys', async () => {
    const live = randomUUID();
    const dead = randomUUID();
    await push(t, live, 'customer.create', { id: randomUUID(), name: 'Live Key' });
    await push(t, dead, 'customer.create', { id: randomUUID(), name: 'Dead Key' });

    const c = await ownerClient();
    await c.query(
      "UPDATE operation_keys SET expires_at = now() - interval '1 day' WHERE op_id = $1",
      [dead],
    );

    const removed = await runWithContext(
      { requestId: 'purge-test', startedAt: Date.now(), ip: undefined, tenantId: t.tenantId },
      () => purgeExpiredKeys(),
    );
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await keyRows(dead)).toBe(0);
    expect(await keyRows(live)).toBe(1);
  });

  it('after a key has expired, entity ids and status guards still make the repeat safe', async () => {
    const customerId = randomUUID();
    const opId = randomUUID();
    expect((await push(t, opId, 'customer.create', { id: customerId, name: 'Old Op' })).status).toBe(
      'applied',
    );
    await (await ownerClient()).query('DELETE FROM operation_keys WHERE op_id = $1', [opId]);

    const repeat = await push(t, opId, 'customer.create', { id: customerId, name: 'Old Op' });
    expect(repeat.status).toBe('replayed');
  });
});
