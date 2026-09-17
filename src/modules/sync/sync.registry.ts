/**
 * The explicit allowlist of tables a device receives through the change feed.
 *
 * Every table here carries `server_seq` from app.setup_tenant_table, so one
 * tenant-wide cursor orders them all. A table missing from this list is
 * invisible to devices; a table listed by mistake leaks data to every device
 * in the tenant. Both are why this is a hand-maintained list rather than a
 * catalogue scan.
 *
 * Deliberately excluded:
 *   devices, refresh_tokens   session/security state, per device
 *   number_blocks             delivered via /numbering/leases and pull top-ups
 *   users                     global directory; devices see staff via memberships
 *   audit_log, sync_batches   server-side records with no client use
 *   device_sync_state         the cursor itself
 */

export interface SyncedTable {
  /** Name used on the wire (`entity`), stable across schema changes. */
  readonly entity: string;
  readonly table: string;
  /** Columns that identify a row; composite for the projections. */
  readonly keyColumns: readonly string[];
  /** Whether the table soft-deletes (rows with deleted_at become `delete` ops). */
  readonly softDelete: boolean;
  /**
   * Column holding the tenant. `tenants` is keyed by `id`; everything else by
   * `tenant_id`. Used in the WHERE clause so the (tenant, server_seq) index is
   * hit even though RLS would filter anyway.
   */
  readonly tenantColumn: 'tenant_id' | 'id';
  /** Extra JOIN and fields merged into the row (e.g. a person's name on a membership). */
  readonly join?: { readonly sql: string; readonly fields: string };
  /** Which pushed operation types write this table; documentation for clients. */
  readonly pushedBy: readonly string[];
}

const table = (
  entity: string,
  keyColumns: readonly string[],
  softDelete: boolean,
  pushedBy: readonly string[] = [],
  extra: Partial<SyncedTable> = {},
): SyncedTable => ({
  entity,
  table: entity,
  keyColumns,
  softDelete,
  tenantColumn: 'tenant_id',
  pushedBy,
  ...extra,
});

export const SYNC_TABLES: readonly SyncedTable[] = [
  table('tenants', ['id'], true, [], { tenantColumn: 'id' }),
  table('outlets', ['id'], true),
  table('counters', ['id'], true),
  table('memberships', ['id'], true, [], {
    join: {
      sql: 'JOIN users u ON u.id = t.user_id',
      fields: `'userName', u.name, 'userPhone', u.phone, 'userEmail', u.email, 'userIsActive', u.is_active`,
    },
  }),
  table('subscriptions', ['id'], false),
  table('categories', ['id'], true, ['category.create', 'category.update']),
  table('items', ['id'], true, ['item.create', 'item.update']),
  table('item_barcodes', ['id'], true, ['item.create', 'item.update']),
  table('customers', ['id'], true, ['customer.create', 'customer.update']),
  table('customer_balances', ['customer_id'], false),
  table('document_series', ['id'], true),
  table('invoices', ['id'], false, ['invoice.create', 'invoice.void', 'invoice.printed']),
  table('invoice_lines', ['id'], false, ['invoice.create']),
  table('credit_notes', ['id'], false, [
    'credit_note.create',
    'credit_note.void',
    'credit_note.printed',
  ]),
  table('credit_note_lines', ['id'], false, ['credit_note.create']),
  table('payments', ['id'], false, [
    'invoice.create',
    'payment.create',
    'payment.void',
    'credit_note.create',
  ]),
  table('payment_allocations', ['id'], false, ['invoice.create', 'payment.create']),
  table('customer_ledger_entries', ['id'], false),
  table('stock_ledger_entries', ['id'], false, ['stock.adjust']),
  table('stock_balances', ['outlet_id', 'item_id'], false),
  // A parked bill is shared across the counter's devices on purpose: a
  // cashier going home must not strand a customer's bill on their phone.
  table('held_bills', ['id'], true, ['held_bill.upsert', 'held_bill.release']),
  table('expense_categories', ['id'], true),
  table('expenses', ['id'], false, ['expense.create', 'expense.void']),
  table('day_closes', ['id'], false, ['day_close.create']),
];

export const SYNC_ENTITIES = SYNC_TABLES.map((t) => t.entity);

export function findSyncedTable(entity: string): SyncedTable | undefined {
  return SYNC_TABLES.find((t) => t.entity === entity);
}
