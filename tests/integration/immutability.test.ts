/**
 * The database-level guarantees, tested as the API role rather than the owner.
 *
 * These are the controls that stay true even if application code is wrong:
 * revoked DELETE on documents, revoked UPDATE on ledgers, and the trigger that
 * pins which columns of an issued document may ever change. The API exposes no
 * route that violates them, so they are exercised over a direct connection as
 * the same unprivileged role the API uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { closeOwnerClient, truncateAll } from './setup/database.js';
import { integrationEnv } from './setup/env.js';
import { createTenant, type TenantFixture } from './setup/tenant.js';
import {
  createItem,
  createSeries,
  invoicePayload,
  leaseBlock,
  type SeriesFixture,
} from './setup/fixtures.js';
import { data } from './setup/body.js';
import { closePool } from '../../src/db/pool.js';

/**
 * A connection as the API's own role, so RLS and revoked grants both apply.
 *
 * The tenant is set per transaction, never per session. On a transaction-mode
 * pooler a session setting outlives the client that made it: the backend goes
 * back to the pool with app.tenant_id still attached, and the next connection
 * to land on it inherits another tenant's context. src/db/tx.ts avoids this
 * with set_config(..., true), and the harness must not undo that.
 */
async function appClient(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: integrationEnv.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/** Runs one statement with tenant context scoped to its own transaction. */
async function asTenant(
  client: pg.Client,
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await client.query(sql, params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

describe('immutability and append-only contracts', () => {
  let t: TenantFixture;
  let series: SeriesFixture;
  let invoiceId: string;
  let client: pg.Client;

  beforeAll(async () => {
    await truncateAll();
    t = await createTenant({ name: 'Immutable Shop' });
    series = await createSeries(t, { prefix: 'IMM' });
    const block = await leaseBlock(t, series.id, 5);
    const item = await createItem(t);

    const payload = invoicePayload(t, {
      seriesId: series.id,
      sequenceNo: block.startSeq,
      lines: [{ itemId: item.id, quantity: 1000, unitPrice: 10_000, taxRatePercent: 18 }],
      payments: [{ id: randomUUID(), mode: 'cash', amount: 11_800 }],
    });
    invoiceId = data<{ id: string }>(await t.post('/v1/invoices').send(payload).expect(201)).id;

    client = await appClient();
  });

  afterAll(async () => {
    await client.end();
    await closeOwnerClient();
    await closePool();
  });

  // Tenant context matters here: without it RLS matches no rows, the UPDATE
  // touches nothing, the trigger never fires, and the test would pass for
  // entirely the wrong reason.
  it('refuses to change a financial column on an issued invoice', async () => {
    await expect(
      asTenant(client, t.tenantId, 'UPDATE invoices SET grand_total = 1 WHERE id = $1', [
        invoiceId,
      ]),
    ).rejects.toThrow(/immutable once issued/i);
  });

  it('refuses to delete an invoice', async () => {
    await expect(
      asTenant(client, t.tenantId, 'DELETE FROM invoices WHERE id = $1', [invoiceId]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to update or delete an invoice line', async () => {
    await expect(
      asTenant(client, t.tenantId, 'UPDATE invoice_lines SET quantity = 1'),
    ).rejects.toThrow(/permission denied/i);
    await expect(asTenant(client, t.tenantId, 'DELETE FROM invoice_lines')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('refuses to rewrite a stock ledger entry', async () => {
    await expect(
      asTenant(client, t.tenantId, 'UPDATE stock_ledger_entries SET quantity_delta = 1'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to rewrite a khata ledger entry', async () => {
    await expect(
      asTenant(client, t.tenantId, 'UPDATE customer_ledger_entries SET debit = 1'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to delete an audit entry', async () => {
    await expect(asTenant(client, t.tenantId, 'DELETE FROM audit_log')).rejects.toThrow(
      /permission denied/i,
    );
  });

  // Status and print columns are the documented exceptions, and the API uses them.
  it('allows the print counter to move', async () => {
    await t.post(`/v1/invoices/${invoiceId}/printed`).expect(200);
    const after = data<{ printCount: number }>(
      await t.get(`/v1/invoices/${invoiceId}`).expect(200),
    );
    expect(after.printCount).toBeGreaterThan(0);
  });

  it('sees no rows at all without a tenant context', async () => {
    const blind = new pg.Client({
      connectionString: integrationEnv.databaseUrl,
      ssl: { rejectUnauthorized: false },
    });
    await blind.connect();
    try {
      // app.current_tenant_id() is NULL, and `tenant_id = NULL` is never true.
      const res = await blind.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM invoices',
      );
      expect(res.rows[0]?.count).toBe(0);
    } finally {
      await blind.end();
    }
  });
});
