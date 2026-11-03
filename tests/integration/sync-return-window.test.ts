/**
 * What a device receives of invoice lines: recent ones only (so a return can be made offline
 * against a bill from another phone), and never the cost of goods.
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
} from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';
import { env } from '../../src/config/env.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Change {
  entity: string;
  op: string;
  row: Record<string, unknown>;
}

async function pullAll(who: TenantFixture): Promise<Change[]> {
  const all: Change[] = [];
  let cursor = 0;
  for (;;) {
    const page = data<{ changes: Change[]; nextSince: number; hasMore: boolean }>(
      await who.get(`/v1/sync/changes?since=${cursor}&limit=500`).expect(200),
    );
    all.push(...page.changes);
    cursor = page.nextSince;
    if (!page.hasMore) break;
  }
  return all;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('invoice lines sent to devices', () => {
  let t: TenantFixture;
  let recentInvoiceId: string;
  let oldInvoiceId: string;

  beforeAll(async () => {
    t = await createTenant({ name: 'Return Window Shop' });
    const itemId = (await createItem(t, { trackStock: false })).id;
    const series = await createSeries(t, { prefix: 'WIN' });
    const block = await leaseBlock(t, series.id, 10);
    const lines = [{ itemId, quantity: 1000, unitPrice: 5_000, taxRatePercent: 5 }];
    const paid = [{ id: randomUUID(), mode: 'cash', amount: expectedTotals(lines).grandTotal }];

    const issue = async (sequenceNo: number, when: Date) => {
      const payload = {
        ...invoicePayload(t, { seriesId: series.id, sequenceNo, lines, payments: paid }),
        documentDate: when.toISOString().slice(0, 10),
        issuedAt: when.toISOString(),
      };
      // Payments carry their own ids, so each invoice needs a fresh one.
      payload.payments = [{ id: randomUUID(), mode: 'cash', amount: paid[0]!.amount }];
      const res = await t
        .post('/v1/sync/push')
        .send({ operations: [{ opId: randomUUID(), type: 'invoice.create', payload }] })
        .expect(200);
      const result = data<{ results: { status: string; error?: unknown }[] }>(res).results[0]!;
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
      return payload.id;
    };

    recentInvoiceId = await issue(block.startSeq, new Date());
    oldInvoiceId = await issue(block.startSeq + 1, daysAgo(env.SYNC_RETURN_WINDOW_DAYS + 20));
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  it('sends a recent bill\'s lines, and every bill\'s header', async () => {
    const changes = await pullAll(t);
    const headers = changes.filter((c) => c.entity === 'invoices').map((c) => c.row['id']);
    expect(headers).toContain(recentInvoiceId);
    expect(headers).toContain(oldInvoiceId);

    const lineFor = (id: string) =>
      changes.filter((c) => c.entity === 'invoice_lines' && c.row['invoiceId'] === id);
    expect(lineFor(recentInvoiceId)).toHaveLength(1);
    expect(lineFor(oldInvoiceId)).toHaveLength(0);
  });

  it('never sends the cost of goods', async () => {
    const lines = (await pullAll(t)).filter((c) => c.entity === 'invoice_lines');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.row).not.toHaveProperty('cogsAmount');
      expect(l.row).not.toHaveProperty('tenantId');
      expect(l.row).toHaveProperty('lineTotal');
      expect(l.row).toHaveProperty('taxRatePercent');
    }
  });
});
