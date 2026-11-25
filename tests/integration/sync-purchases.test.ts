/**
 * Purchase bills, supplier payments and debit notes made on a device while offline and pushed
 * later: the numbers the device leased, the operations it queues, and what other devices pull.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem } from './setup/fixtures.js';
import { addMember } from './setup/orders.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Block {
  seriesId: string;
  startSeq: number;
  endSeq: number;
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
  status: 'applied' | 'replayed' | 'rejected';
  error?: { code: string; message: string };
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

/** Lease on the first pull, series rows on the second, as on a real phone. */
async function firstSync(who: TenantFixture): Promise<Pulled> {
  const one = await pull(who);
  const two = await pull(who, one.cursor);
  return {
    changes: [...one.changes, ...two.changes],
    leases: [...one.leases, ...two.leases],
    cursor: two.cursor,
  };
}

async function push(who: TenantFixture, type: string, payload: unknown): Promise<OpResult> {
  const res = await who
    .post('/v1/sync/push')
    .send({ operations: [{ opId: randomUUID(), type, payload }] })
    .expect(200);
  return data<{ results: OpResult[] }>(res).results[0]!;
}

const typesOf = (p: Pulled) =>
  new Map(
    p.changes
      .filter((c) => c.entity === 'document_series')
      .map((c) => [c.row['id'] as string, c.row['documentType'] as string]),
  );

function blockFor(p: Pulled, type: string): Block {
  const types = typesOf(p);
  const block = p.leases.find((b) => types.get(b.seriesId) === type);
  if (!block) throw new Error(`no ${type} lease; got ${[...types.values()].join(',')}`);
  return block;
}

describe('offline purchasing through sync', () => {
  let t: TenantFixture;
  let itemId: string;
  let supplierId: string;
  let first: Pulled;
  let nextBill = 0;
  let nextNote = 0;

  /** Bill body as the phone sends it: quantity in thousandths, money in paise. */
  const billBody = (extra: Record<string, unknown> = {}) => {
    const block = blockFor(first, 'purchase_bill');
    const id = randomUUID();
    return {
      id,
      outletId: t.outletId,
      supplierId,
      documentDate: new Date().toISOString().slice(0, 10),
      supplierInvoiceNo: `S-${id.slice(0, 8)}`,
      supplierInvoiceDate: new Date().toISOString().slice(0, 10),
      pricesIncludeTax: false,
      roundOff: false,
      seriesId: block.seriesId,
      sequenceNo: block.startSeq + nextBill++,
      lines: [
        { id: randomUUID(), itemId, quantity: 5000, unitPrice: 4_000, taxRatePercent: 18 },
      ],
      freightAmount: 0,
      landedCostBasis: 'value',
      receivedAt: new Date().toISOString(),
      paidAmount: 0,
      ...extra,
    };
  };

  beforeAll(async () => {
    t = await createTenant({ name: 'Offline Purchases Shop' });
    itemId = (await createItem(t, { trackStock: true })).id;
    supplierId = randomUUID();
    await push(t, 'supplier.create', { id: supplierId, name: 'Fresh Foods', stateCode: '27' });
    first = await firstSync(t);
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('leases an owner blocks for bills and debit notes, a cashier neither', async () => {
    expect(blockFor(first, 'purchase_bill').endSeq).toBeGreaterThanOrEqual(1);
    expect(blockFor(first, 'debit_note').endSeq).toBeGreaterThanOrEqual(1);
    const cashier = await addMember(t, 'cashier');
    const p = await firstSync(cashier);
    const leased = new Set(p.leases.map((b) => typesOf(p).get(b.seriesId)));
    expect(leased.has('purchase_bill')).toBe(false);
    expect(leased.has('debit_note')).toBe(false);
  });

  it('records a bill with the leased number, and other devices pull it with its lines', async () => {
    const body = billBody();
    const made = await push(t, 'purchase_bill.create', body);
    expect(made.status).toBe('applied');

    const res = data<{ documentNumber: string; grandTotal: number; lines: { quantity: number }[] }>(
      await t.get(`/v1/purchase-bills/${body.id}`).expect(200),
    );
    expect(res.documentNumber).toMatch(new RegExp(`^PB/.+/0*${body.sequenceNo}$`));
    // 5 units × 40.00 = 200.00 + 18% GST.
    expect(res.grandTotal).toBe(23_600);
    expect(res.lines[0]!.quantity).toBe(5000);

    const pulled = await pull(t, first.cursor);
    const entities = new Set(pulled.changes.map((c) => c.entity));
    expect(entities.has('purchase_bills')).toBe(true);
    expect(entities.has('purchase_bill_lines')).toBe(true);
  });

  it('a retried bill is replayed, not recorded twice', async () => {
    const body = billBody();
    expect((await push(t, 'purchase_bill.create', body)).status).toBe('applied');
    expect((await push(t, 'purchase_bill.create', body)).status).toBe('replayed');
  });

  it('refuses a number this device was never leased', async () => {
    const block = blockFor(first, 'purchase_bill');
    const res = await push(t, 'purchase_bill.create', billBody({ sequenceNo: block.endSeq + 500 }));
    expect(res.status).toBe('rejected');
    expect(res.error?.code).toBe('NUMBER_NOT_LEASED');
  });

  it('refuses the same supplier invoice twice', async () => {
    const body = billBody();
    await push(t, 'purchase_bill.create', body);
    const dup = await push(t, 'purchase_bill.create', billBody({ supplierInvoiceNo: body.supplierInvoiceNo }));
    expect(dup.status).toBe('rejected');
    expect(dup.error?.code).toBe('DUPLICATE_SUPPLIER_INVOICE');
  });

  it('pays a bill, pulls the payment and its allocation, and cancels it', async () => {
    const bill = billBody();
    await push(t, 'purchase_bill.create', bill);
    const cursor = (await pull(t)).cursor;

    const paymentId = randomUUID();
    const paid = await push(t, 'supplier_payment.create', {
      id: paymentId,
      outletId: t.outletId,
      supplierId,
      mode: 'upi',
      amount: 10_000,
      paidAt: new Date().toISOString(),
      allocations: [{ purchaseBillId: bill.id, amount: 10_000 }],
    });
    expect(paid.status).toBe('applied');

    const after = await pull(t, cursor);
    expect(after.changes.some((c) => c.entity === 'supplier_payments' && c.row['id'] === paymentId)).toBe(true);
    expect(
      after.changes.some(
        (c) => c.entity === 'supplier_payment_allocations' && c.row['purchaseBillId'] === bill.id,
      ),
    ).toBe(true);

    // A retried payment is the same payment.
    const again = await push(t, 'supplier_payment.create', {
      id: paymentId,
      outletId: t.outletId,
      supplierId,
      mode: 'upi',
      amount: 10_000,
      paidAt: new Date().toISOString(),
    });
    expect(again.status).toBe('replayed');

    // A bill with a payment cannot be cancelled until the payment is.
    expect((await push(t, 'purchase_bill.void', { id: bill.id, reason: 'oops' })).status).toBe('rejected');
    expect((await push(t, 'supplier_payment.void', { id: paymentId, reason: 'bounced' })).status).toBe('applied');
    const voided = await push(t, 'purchase_bill.void', { id: bill.id, reason: 'oops' });
    expect(voided, JSON.stringify(voided)).toMatchObject({ status: 'applied' });
    // A retried cancellation is not an error.
    expect((await push(t, 'purchase_bill.void', { id: bill.id, reason: 'oops' })).status).toBe('applied');
  });

  it('sends goods back with a leased debit note number, and cancels the return', async () => {
    const bill = billBody();
    await push(t, 'purchase_bill.create', bill);
    const noteBlock = blockFor(first, 'debit_note');
    const noteId = randomUUID();
    const body = {
      id: noteId,
      purchaseBillId: bill.id,
      seriesId: noteBlock.seriesId,
      sequenceNo: noteBlock.startSeq + nextNote++,
      documentDate: new Date().toISOString().slice(0, 10),
      reasonCode: 'damaged',
      restock: true,
      lines: [{ id: randomUUID(), purchaseBillLineId: bill.lines[0]!.id, quantity: 2000 }],
      issuedAt: new Date().toISOString(),
    };
    expect((await push(t, 'debit_note.create', body)).status).toBe('applied');
    expect((await push(t, 'debit_note.create', body)).status).toBe('replayed');

    const note = data<{ documentNumber: string; grandTotal: number }>(
      await t.get(`/v1/debit-notes/${noteId}`).expect(200),
    );
    expect(note.documentNumber).toMatch(new RegExp(`^DN/.+/0*${body.sequenceNo}$`));
    // 2 units × 40.00 = 80.00 + 18% GST.
    expect(note.grandTotal).toBe(9_440);

    // Returning more than is left is refused.
    const tooMany = await push(t, 'debit_note.create', {
      ...body,
      id: randomUUID(),
      sequenceNo: noteBlock.startSeq + nextNote++,
      lines: [{ id: randomUUID(), purchaseBillLineId: bill.lines[0]!.id, quantity: 4000 }],
    });
    expect(tooMany.status).toBe('rejected');

    const noteVoid = await push(t, 'debit_note.void', { id: noteId, reason: 'refused' });
    expect(noteVoid, JSON.stringify(noteVoid)).toMatchObject({ status: 'applied' });
  });
});
