/**
 * Two phones, both offline, create the same customer / supplier / item / category, or edit the same
 * record. The server merges instead of rejecting, and tells each phone what happened.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { closeOwnerClient, ownerClient } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import {
  createItem,
  createSeries,
  expectedTotals,
  invoicePayload,
  leaseBlock,
} from './setup/fixtures.js';
import { addMember } from './setup/orders.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface OpResult {
  opId: string;
  status: 'applied' | 'replayed' | 'rejected';
  id?: string;
  serverSeq?: number;
  retryable?: boolean;
  warnings?: { code: string; details?: { fields?: string[] } }[];
  mergedInto?: { entity: string; aliasId: string; canonicalId: string };
  error?: { code: string; message: string };
}

async function push(
  who: TenantFixture,
  type: string,
  payload: unknown,
  opts: { opId?: string; baseServerSeq?: number } = {},
): Promise<OpResult> {
  const res = await who
    .post('/v1/sync/push')
    .send({
      operations: [
        {
          opId: opts.opId ?? randomUUID(),
          type,
          payload,
          ...(opts.baseServerSeq !== undefined ? { baseServerSeq: opts.baseServerSeq } : {}),
        },
      ],
    })
    .expect(200);
  return data<{ results: OpResult[] }>(res).results[0]!;
}

/** A phone number no other test in this business has used. */
const freshPhone = () => `98${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

describe('merging what two offline phones did', () => {
  let a: TenantFixture;
  let b: TenantFixture;

  const customer = async (who: TenantFixture, id: string) =>
    data<{ id: string; name: string; city?: string; notes?: string; balance: number }>(
      await who.get(`/v1/customers/${id}`).expect(200),
    );

  beforeAll(async () => {
    a = await createTenant({ name: 'Merge Shop' });
    b = await addMember(a, 'manager');
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  describe('a duplicate create', () => {
    it('merges a customer with the same phone into the existing one', async () => {
      const phone = freshPhone();
      const first = randomUUID();
      const second = randomUUID();
      expect((await push(a, 'customer.create', { id: first, name: 'Asha', phone })).status).toBe(
        'applied',
      );

      const merged = await push(b, 'customer.create', {
        id: second,
        name: 'Asha K.',
        phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, // written differently, same number
      });
      expect(merged.status).toBe('applied');
      expect(merged.id).toBe(first);
      expect(merged.mergedInto).toEqual({ entity: 'customer', aliasId: second, canonicalId: first });

      // The duplicate never became a record of its own.
      await b.get(`/v1/customers/${second}`).expect(404);
      expect((await customer(b, first)).name).toBe('Asha');
    });

    it('answers a retry of the merge the same way', async () => {
      const phone = freshPhone();
      const first = randomUUID();
      const second = randomUUID();
      await push(a, 'customer.create', { id: first, name: 'Ravi', phone });
      const opId = randomUUID();
      const one = await push(b, 'customer.create', { id: second, name: 'Ravi', phone }, { opId });
      const again = await push(b, 'customer.create', { id: second, name: 'Ravi', phone }, { opId });
      expect(again.status).toBe('replayed');
      expect(again.mergedInto).toEqual(one.mergedInto);
      expect(again.id).toBe(first);

      // Even with a fresh opId (the key long expired), the alias still answers.
      const later = await push(b, 'customer.create', { id: second, name: 'Ravi', phone });
      expect(later.id).toBe(first);
      expect(later.mergedInto?.canonicalId).toBe(first);
    });

    it('does not add the duplicate\'s opening balance a second time, and says so', async () => {
      const phone = freshPhone();
      const first = randomUUID();
      const second = randomUUID();
      await push(a, 'customer.create', { id: first, name: 'Meena', phone });
      const merged = await push(b, 'customer.create', {
        id: second,
        name: 'Meena',
        phone,
        openingBalance: 5_000,
      });
      expect(merged.warnings?.map((w) => w.code)).toContain('OPENING_BALANCE_IGNORED');
      expect((await customer(a, first)).balance).toBe(0);
    });

    it('sends what the other phone queued against its own duplicate to the real record', async () => {
      const phone = freshPhone();
      const first = randomUUID();
      const second = randomUUID();
      await push(a, 'customer.create', { id: first, name: 'Kiran', phone });
      await push(b, 'customer.create', { id: second, name: 'Kiran', phone });

      // An edit and a bill the second phone made against ITS id.
      const edit = await push(b, 'customer.update', { id: second, patch: { city: 'Pune' } });
      expect(edit.status).toBe('applied');
      expect((await customer(a, first)).city).toBe('Pune');

      const itemId = (await createItem(a, { trackStock: false })).id;
      const series = await createSeries(a, { prefix: 'MRG' });
      const block = await leaseBlock(a, series.id, 5);
      const lines = [{ itemId, quantity: 1000, unitPrice: 5_000, taxRatePercent: 5 }];
      const bill = invoicePayload(a, {
        seriesId: series.id,
        sequenceNo: block.startSeq,
        lines,
        customerId: second, // the second phone's own id for Kiran
        payments: [],
      });
      expect(expectedTotals(lines).grandTotal).toBeGreaterThan(0);
      const made = await push(a, 'invoice.create', bill);
      expect(made, JSON.stringify(made)).toMatchObject({ status: 'applied' });
      const invoice = data<{ customerId: string }>(await a.get(`/v1/invoices/${bill.id}`).expect(200));
      expect(invoice.customerId).toBe(first);
    });

    it('merges an item with the same code, ignoring case and spaces', async () => {
      const code = `SKU-${randomUUID().slice(0, 6)}`;
      const first = randomUUID();
      const second = randomUUID();
      const item = {
        itemType: 'goods',
        name: 'Rice 1kg',
        taxRatePercent: 5,
        unit: 'pcs',
        salePrice: 5_000,
        trackStock: false,
        pricesIncludeTax: false,
      };
      expect((await push(a, 'item.create', { id: first, code, ...item })).status).toBe('applied');
      const merged = await push(b, 'item.create', {
        id: second,
        code: ` ${code.toLowerCase()} `,
        ...item,
        name: 'Rice, one kilo',
      });
      expect(merged.mergedInto).toEqual({ entity: 'item', aliasId: second, canonicalId: first });
    });

    it('does not merge items that merely share a barcode: that stays a refusal', async () => {
      const barcode = `89${String(randomInt(0, 1e10)).padStart(10, '0')}`;
      const item = {
        itemType: 'goods',
        taxRatePercent: 5,
        unit: 'pcs',
        salePrice: 5_000,
        trackStock: false,
        pricesIncludeTax: false,
      };
      await push(a, 'item.create', {
        id: randomUUID(),
        name: 'One',
        code: `C-${randomUUID().slice(0, 6)}`,
        barcodes: [barcode],
        ...item,
      });
      const clash = await push(b, 'item.create', {
        id: randomUUID(),
        name: 'Two',
        code: `C-${randomUUID().slice(0, 6)}`,
        barcodes: [barcode],
        ...item,
      });
      expect(clash.status).toBe('rejected');
      expect(clash.mergedInto).toBeUndefined();
    });

    it('merges a category with the same name under the same parent', async () => {
      const name = `Grains ${randomUUID().slice(0, 6)}`;
      const first = randomUUID();
      const second = randomUUID();
      await push(a, 'category.create', { id: first, name });
      const merged = await push(b, 'category.create', { id: second, name: ` ${name.toUpperCase()} ` });
      expect(merged.mergedInto).toEqual({ entity: 'category', aliasId: second, canonicalId: first });
    });

    it('merges a supplier with the same phone', async () => {
      const phone = freshPhone();
      const first = randomUUID();
      const second = randomUUID();
      await push(a, 'supplier.create', { id: first, name: 'Fresh Foods', phone });
      const merged = await push(b, 'supplier.create', { id: second, name: 'Fresh Foods Ltd', phone });
      expect(merged.mergedInto).toEqual({ entity: 'supplier', aliasId: second, canonicalId: first });
    });

    it('still creates a customer with a phone nobody has, or none at all', async () => {
      const id = randomUUID();
      const made = await push(b, 'customer.create', { id, name: 'No Phone' });
      expect(made.status).toBe('applied');
      expect(made.mergedInto).toBeUndefined();
      expect(made.id).toBe(id);
    });
  });

  describe('two edits of the same record', () => {
    const newCustomer = async (extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await push(a, 'customer.create', { id, name: 'Base', phone: freshPhone(), ...extra });
      return id;
    };

    it('keeps both when they changed different fields', async () => {
      const id = await newCustomer({ city: 'Nashik' });
      const one = await push(a, 'customer.update', {
        id,
        patch: { city: 'Pune' },
        was: { city: 'Nashik' },
      });
      const two = await push(b, 'customer.update', {
        id,
        patch: { pincode: '411001' },
        was: { pincode: null },
      });
      expect([one.status, two.status]).toEqual(['applied', 'applied']);
      expect(two.warnings).toBeUndefined();
      const row = data<{ city: string; pincode: string }>(await a.get(`/v1/customers/${id}`).expect(200));
      expect(row.city).toBe('Pune');
      expect(row.pincode).toBe('411001');
    });

    it('keeps the later write when both changed the same field, logs the old value, and says so', async () => {
      const id = await newCustomer();
      await push(a, 'customer.update', { id, patch: { creditLimit: 1_000 }, was: { creditLimit: null } });
      const later = await push(b, 'customer.update', {
        id,
        patch: { creditLimit: 2_000 },
        was: { creditLimit: null }, // it did not know about the 1,000
      });
      expect(later.status).toBe('applied');
      const warning = later.warnings?.find((w) => w.code === 'FIELD_CONFLICT');
      expect(warning?.details?.fields).toEqual(['creditLimit']);

      const row = data<{ creditLimit: number }>(await a.get(`/v1/customers/${id}`).expect(200));
      expect(row.creditLimit).toBe(2_000);

      const audit = await (
        await ownerClient()
      ).query("SELECT changes FROM audit_log WHERE action = 'sync.field_conflict' AND entity_id = $1", [
        id,
      ]);
      expect(audit.rowCount).toBe(1);
      expect((audit.rows[0] as { changes: Record<string, { from: number; to: number }> }).changes[
        'creditLimit'
      ]).toEqual({ from: 1_000, to: 2_000 });
    });

    it('joins notes written on both sides instead of choosing one', async () => {
      const id = await newCustomer({ notes: 'base' });
      await push(a, 'customer.update', { id, patch: { notes: 'from A' }, was: { notes: 'base' } });
      await push(b, 'customer.update', { id, patch: { notes: 'from B' }, was: { notes: 'base' } });
      const row = data<{ notes: string }>(await a.get(`/v1/customers/${id}`).expect(200));
      expect(row.notes).toBe('from A\nfrom B');
    });

    it('does not call it a conflict when both made the very same change', async () => {
      const id = await newCustomer({ city: 'Nashik' });
      await push(a, 'customer.update', { id, patch: { city: 'Pune' }, was: { city: 'Nashik' } });
      const same = await push(b, 'customer.update', {
        id,
        patch: { city: 'Pune' },
        was: { city: 'Nashik' },
      });
      expect(same.warnings).toBeUndefined();
    });

    it('still refuses a stale edit that does not say what it started from (an older build)', async () => {
      const id = await newCustomer();
      const first = await push(a, 'customer.update', { id, patch: { city: 'Pune' } });
      await push(a, 'customer.update', { id, patch: { city: 'Mumbai' } });
      const stale = await push(
        b,
        'customer.update',
        { id, patch: { city: 'Thane' } },
        { baseServerSeq: first.serverSeq! - 1 },
      );
      expect(stale.status).toBe('rejected');
      expect(stale.error?.code).toBe('STALE_WRITE');
    });
  });
});
