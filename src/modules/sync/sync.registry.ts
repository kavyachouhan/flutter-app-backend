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

import { env } from '../../config/env.js';

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
  /**
   * A fixed SQL predicate (on alias `t`) a row must also satisfy to be sent. Used to keep a
   * window of recent rows on devices. Never built from request input.
   */
  readonly where?: string;
  /** Columns removed from every row sent: server-side figures a device must not receive. */
  readonly omit?: readonly string[];
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

/**
 * Only recent lines go to devices: enough for a return to be made offline against a bill from
 * another phone, without every phone carrying years of history. The days come from validated
 * config (a positive integer), so writing it into the query is safe.
 */
const RECENT_LINES = `t.document_date >= current_date - ${env.SYNC_RETURN_WINDOW_DAYS}`;

export const SYNC_TABLES: readonly SyncedTable[] = [
  table('tenants', ['id'], true, [], { tenantColumn: 'id' }),
  table('outlets', ['id'], true),
  table('counters', ['id'], true),
  table('gst_registrations', ['id'], true),
  table('gst_registration_profiles', ['id'], false),
  table('entity_turnover_by_fy', ['id'], false),
  table('memberships', ['id'], true, [], {
    join: {
      sql: 'JOIN users u ON u.id = t.user_id',
      fields: `'userName', u.name, 'userPhone', u.phone, 'userEmail', u.email, 'userIsActive', u.is_active`,
    },
  }),
  table('subscriptions', ['id'], false),
  table('categories', ['id'], true, ['category.create', 'category.update', 'category.delete']),
  table('items', ['id'], true, ['item.create', 'item.update', 'item.delete']),
  table('item_barcodes', ['id'], true, ['item.create', 'item.update']),
  table('customers', ['id'], true, ['customer.create', 'customer.update', 'customer.delete']),
  table('customer_addresses', ['id'], true, ['customer_address.upsert', 'customer_address.delete']),
  table('terms_conditions', ['id'], true, ['terms.create', 'terms.update', 'terms.delete']),
  table('customer_balances', ['customer_id'], false),
  table('document_series', ['id'], true),
  table('invoices', ['id'], false, ['invoice.create', 'invoice.void', 'invoice.printed']),
  // `cogs_amount` is what the shop paid for the goods: a margin figure that a cashier's phone has
  // no use for, so it is never sent.
  table('invoice_lines', ['id'], false, ['invoice.create'], {
    where: RECENT_LINES,
    omit: ['cogs_amount'],
  }),
  table('sales_debit_notes', ['id'], false, ['sales_debit_note.create', 'sales_debit_note.void']),
  table('sales_debit_note_lines', ['id'], false, ['sales_debit_note.create']),
  table('financial_credit_notes', ['id'], false, ['financial_credit_note.create', 'financial_credit_note.void']),
  table('credit_notes', ['id'], false, [
    'credit_note.create',
    'credit_note.void',
    'credit_note.printed',
  ]),
  table('credit_note_lines', ['id'], false, ['credit_note.create'], { where: RECENT_LINES }),
  table('payments', ['id'], false, [
    'invoice.create',
    'payment.create',
    'payment.void',
    'credit_note.create',
  ]),
  table('payment_allocations', ['id'], false, ['invoice.create', 'payment.create']),
  table('customer_ledger_entries', ['id'], false),
  // Pull-only, and mandatory rather than optional: a till cannot price a
  // wholesale customer offline without the lists, and cannot enforce a cap it
  // has never seen. The policy rows are small and change rarely.
  table('price_lists', ['id'], true),
  table('price_list_items', ['price_list_id', 'item_id', 'min_quantity'], true),
  table('discount_policies', ['id'], true),
  // Pushed with the invoice that carries the discount, never on its own, so
  // there is no operation type of its own — `invoice.create` writes it.
  table('discount_approvals', ['id'], false),
  // Pull-only. A supplier return is keyed in on a connected screen, so the
  // device never originates one — but it must see them, or a till shows stock
  // it no longer has and a reorder suggestion built on it is wrong.
  table('debit_notes', ['id'], false, ['debit_note.create', 'debit_note.void']),
  table('debit_note_lines', ['id'], false, ['debit_note.create']),
  // Purchase bills and supplier payments are made on a device and pushed, like an invoice and a
  // receipt. The supplier ledger is pulled whole so a statement reads the same offline.
  table('purchase_bills', ['id'], false, ['purchase_bill.create', 'purchase_bill.void']),
  table('purchase_bill_lines', ['id'], false, ['purchase_bill.create']),
  table('supplier_payments', ['id'], false, ['supplier_payment.create', 'supplier_payment.void']),
  table('supplier_payment_allocations', ['id'], false, ['supplier_payment.create']),
  table('supplier_ledger_entries', ['id'], false),
  table('stock_ledger_entries', ['id'], false, ['stock.adjust']),
  table('stock_balances', ['outlet_id', 'item_id'], false),
  // A parked bill is shared across the counter's devices on purpose: a
  // cashier going home must not strand a customer's bill on their phone.
  table('held_bills', ['id'], true, ['held_bill.upsert', 'held_bill.release']),
  // Deliberately absent: gst_return_periods, itc_register, gstr2b_*. A return
  // is prepared and filed on a connected screen by whoever does the books, and
  // a till has no use for an ITC register — syncing it would push a shop's tax
  // position onto every phone for nothing.
  // Documents a device can make offline. The lines are their own tables with soft delete, so a
  // line removed in an edit reaches every device as a delete rather than lingering.
  table('suppliers', ['id'], true, ['supplier.create', 'supplier.update', 'supplier.delete']),
  // Pull-only, like a customer's: what the shop owes comes from purchase bills and payments the
  // server keeps, so a phone shows the figure and never writes it.
  table('supplier_balances', ['supplier_id'], false),
  table('estimates', ['id'], true, [
    'estimate.create',
    'estimate.update',
    'estimate.delete',
    'estimate.cancel',
    'estimate.close',
    'estimate.convert',
  ]),
  table('estimate_lines', ['id'], true, ['estimate.create', 'estimate.update']),
  // Converted by the invoice that names it, so there is no convert operation here.
  table('proforma_invoices', ['id'], true, [
    'proforma_invoice.create',
    'proforma_invoice.update',
    'proforma_invoice.delete',
    'proforma_invoice.cancel',
    'proforma_invoice.close',
  ]),
  table('proforma_invoice_lines', ['id'], true, [
    'proforma_invoice.create',
    'proforma_invoice.update',
  ]),
  table('sales_orders', ['id'], true, [
    'sale_order.create',
    'sale_order.update',
    'sale_order.delete',
    'sale_order.cancel',
    'sale_order.close',
    'estimate.convert',
  ]),
  table('sales_order_lines', ['id'], true, [
    'sale_order.create',
    'sale_order.update',
    'estimate.convert',
  ]),
  table('purchase_orders', ['id'], true, [
    'purchase_order.create',
    'purchase_order.update',
    'purchase_order.delete',
    'purchase_order.cancel',
  ]),
  table('purchase_order_lines', ['id'], true, ['purchase_order.create', 'purchase_order.update']),
  table('expense_categories', ['id'], true, [
    'expense_category.create',
    'expense_category.update',
    'expense_category.delete',
  ]),
  table('expenses', ['id'], false, ['expense.create', 'expense.void']),
  table('day_closes', ['id'], false, ['day_close.create']),
];

export const SYNC_ENTITIES = SYNC_TABLES.map((t) => t.entity);

export function findSyncedTable(entity: string): SyncedTable | undefined {
  return SYNC_TABLES.find((t) => t.entity === entity);
}
