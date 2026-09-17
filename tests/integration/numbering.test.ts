/**
 * The duplicate-number wedge: "your invoice numbers will never duplicate".
 *
 * The application locks the series row before handing out a block, but the
 * guarantee is the EXCLUDE USING gist constraint on number_blocks, which holds
 * whatever the application does. Concurrency is the only way to exercise it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeOwnerClient, truncateAll } from './setup/database.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import { createSeries, leaseBlock } from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

describe('document numbering', () => {
  let t: TenantFixture;

  beforeAll(async () => {
    await truncateAll();
    t = await createTenant({ name: 'Numbering Shop' });
  });

  afterAll(async () => {
    await closeOwnerClient();
    await closePool();
  });

  // Each test needs its own series, and a tenant may hold only one invoice
  // series per counter per financial year. None of these issue invoices, so
  // the year is just a way to give each one a distinct scope.
  it('hands out contiguous, non-overlapping blocks', async () => {
    const series = await createSeries(t, { prefix: 'SEQ', fyStartYear: 2031 });
    const first = await leaseBlock(t, series.id, 5);
    const second = await leaseBlock(t, series.id, 5);

    expect(first.endSeq).toBeGreaterThanOrEqual(first.startSeq);
    expect(second.startSeq).toBe(first.endSeq + 1);
  });

  it('never overlaps blocks under concurrent leases', async () => {
    const series = await createSeries(t, { prefix: 'CONC', fyStartYear: 2032 });
    const blocks = await Promise.all(Array.from({ length: 6 }, () => leaseBlock(t, series.id, 4)));

    const sorted = [...blocks].sort((x, y) => x.startSeq - y.startSeq);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      // The constraint the whole wedge rests on: ranges may not intersect.
      expect(current.startSeq).toBeGreaterThan(previous.endSeq);
    }

    const numbers = sorted.flatMap((b) =>
      Array.from({ length: b.endSeq - b.startSeq + 1 }, (_, i) => b.startSeq + i),
    );
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('reports the format ceiling so a device can render offline', async () => {
    const series = await createSeries(t, { prefix: 'VIEW', fyStartYear: 2033 });
    const listed = data<{ id: string; maxSequence: number; maxLength: number }[]>(
      await t.get('/v1/numbering/series').expect(200),
    );
    const mine = listed.find((s) => s.id === series.id);
    expect(mine?.maxSequence).toBeGreaterThan(0);
    expect(mine?.maxLength).toBe(16);
  });

  it('is idempotent on the client-supplied series id', async () => {
    const fy = 2034;
    const series = await createSeries(t, { prefix: 'IDEM', fyStartYear: fy });
    // Re-creating with the same id returns the existing row, not a duplicate.
    const again = await t
      .post('/v1/numbering/series')
      .send({
        id: series.id,
        outletId: t.outletId,
        counterId: t.counterId,
        documentType: 'invoice',
        fyStartYear: fy,
        prefix: 'DIFFERENT',
        includeOutletCode: false,
        includeCounterCode: false,
        includeFinancialYear: true,
        padding: 4,
        separator: '/',
        startingSequence: 1,
      })
      .expect(201);
    expect(data<{ id: string; prefix: string }>(again).prefix).toBe('IDEM');
  });
});
