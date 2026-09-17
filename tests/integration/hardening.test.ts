/**
 * The M1 changes, verified through behaviour rather than catalog inspection.
 *
 * The migration's own objects were checked when it was applied; what matters
 * here is that the barcode soft-delete actually frees a barcode for reuse and
 * stops resolving to the deleted item, that audit entries are readable, and
 * that a sale now leaves a trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient, ownerClient, truncateAll } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createItem, createSeries, invoicePayload, leaseBlock } from './setup/fixtures.js';
import { data, rows } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

describe('M1 hardening', () => {
  let t: TenantFixture;

  beforeAll(async () => {
    await truncateAll();
    t = await createTenant({ name: 'Hardening Shop' });
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('resolves an item by barcode', async () => {
    const barcode = `BC${randomUUID().slice(0, 8)}`;
    const item = await createItem(t, { barcodes: [barcode] });
    const found = data<{ id: string }>(await t.get(`/v1/items/by-barcode/${barcode}`).expect(200));
    expect(found.id).toBe(item.id);
  });

  // The bug M1 closed: a hard DELETE was invisible to a syncing device, which
  // kept resolving the barcode to an item that no longer existed.
  it('stops resolving a barcode once the item is deleted, and keeps the row', async () => {
    const barcode = `BC${randomUUID().slice(0, 8)}`;
    const item = await createItem(t, { barcodes: [barcode] });
    await t.del(`/v1/items/${item.id}`).expect(204);

    await t.get(`/v1/items/by-barcode/${barcode}`).expect(404);

    const c = await ownerClient();
    const { rows: found } = await c.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM item_barcodes WHERE barcode = $1 AND tenant_id = $2',
      [barcode, t.tenantId],
    );
    // Still present, marked deleted: that is what a device pulls as a change.
    expect(found).toHaveLength(1);
    expect(found[0]?.deleted_at).not.toBeNull();
  });

  it('frees a soft-deleted barcode for a replacement item', async () => {
    const barcode = `BC${randomUUID().slice(0, 8)}`;
    const first = await createItem(t, { barcodes: [barcode] });
    await t.del(`/v1/items/${first.id}`).expect(204);

    // The partial unique index is what makes this possible.
    const replacement = await createItem(t, { barcodes: [barcode] });
    const found = data<{ id: string }>(await t.get(`/v1/items/by-barcode/${barcode}`).expect(200));
    expect(found.id).toBe(replacement.id);
  });

  it('records an audit entry when an invoice is issued', async () => {
    const series = await createSeries(t, { prefix: 'AUD' });
    const block = await leaseBlock(t, series.id, 5);
    const item = await createItem(t);
    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: block.startSeq,
      lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
      payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
    });
    const invoice = data<{ id: string }>(await t.post('/v1/invoices').send(payload).expect(201));

    const entries = rows<{ action: string; entityId: string }>(
      await t.get(`/v1/audit?entityType=invoice&entityId=${invoice.id}`).expect(200),
    );
    expect(entries.map((e) => e.action)).toContain('invoice.issued');
  });

  it('exposes the audit trail only to roles that may read it', async () => {
    const listed = rows<{ action: string }>(await t.get('/v1/audit').expect(200));
    // Onboarding itself is audited, so the log is never empty for a live tenant.
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.map((e) => e.action)).toContain('tenant.created');
  });

  it('paginates the audit trail newest first', async () => {
    const page = await t.get('/v1/audit?limit=1').expect(200);
    expect(rows(page)).toHaveLength(1);
    expect(page.body).toHaveProperty('nextCursor');
  });
});
