-- 0005 — Hardening: sync-visible barcode deletes and the indexes and
-- denormalised columns the sales and cash reports need.
--
-- Table contracts are unchanged. item_barcodes stays a mutable master (soft
-- delete); invoice_lines stays immutable document detail (UPDATE and DELETE
-- revoked); payments and customer_ledger_entries gain indexes only.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- item_barcodes: soft delete
--
-- A hard DELETE is invisible to a syncing device. The row simply stops
-- existing, so nothing in the change stream tells a till to forget it, and it
-- keeps resolving a scanned barcode to an item that was deleted weeks ago.
--
-- The hard delete was there because the unique index is not partial, so a
-- freed barcode could not be reused by a replacement item. Both have to change
-- together, which is why they are one migration.
-- ===========================================================================

ALTER TABLE item_barcodes ADD COLUMN deleted_at TIMESTAMPTZ;

DROP INDEX item_barcodes_uq;
-- Scanning must still resolve to exactly one *live* item.
CREATE UNIQUE INDEX item_barcodes_uq ON item_barcodes (tenant_id, barcode)
  WHERE deleted_at IS NULL;


-- ===========================================================================
-- invoice_lines: outlet and date, denormalised
--
-- Item-wise and category-wise sales are the two most-run reports in the
-- product, and both filter by outlet and date — columns that live on the
-- parent invoice. Without them every such report joins and scans the tenant's
-- entire line history. Denormalising is safe here precisely because the table
-- forbids UPDATE and DELETE: there is no update anomaly to keep in sync.
-- ===========================================================================

ALTER TABLE invoice_lines
  ADD COLUMN outlet_id     UUID,
  ADD COLUMN document_date DATE;

-- The backfill is an UPDATE against a table whose contract forbids UPDATE, so
-- the restriction trigger is suspended for it. The sync and timestamp triggers
-- go too: re-stamping would burn one server_seq per line against the
-- single per-tenant counter and republish the shop's whole invoice history to
-- every device, for a change that carries no information a client wants.
--
-- FORCE ROW LEVEL SECURITY applies policies to the table owner as well, and
-- app.current_tenant_id() is NULL in a migration, so the tenant_isolation
-- policy would match zero rows and the backfill would silently do nothing.
-- Dropping FORCE (not the policy) restores the normal owner exemption.
ALTER TABLE invoice_lines DISABLE TRIGGER invoice_lines_restricted;
ALTER TABLE invoice_lines DISABLE TRIGGER invoice_lines_server_seq;
ALTER TABLE invoice_lines DISABLE TRIGGER invoice_lines_updated_at;
ALTER TABLE invoice_lines NO FORCE ROW LEVEL SECURITY;

UPDATE invoice_lines l
   SET outlet_id     = i.outlet_id,
       document_date = i.document_date
  FROM invoices i
 WHERE i.id = l.invoice_id
   AND i.tenant_id = l.tenant_id;

ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE TRIGGER invoice_lines_updated_at;
ALTER TABLE invoice_lines ENABLE TRIGGER invoice_lines_server_seq;
ALTER TABLE invoice_lines ENABLE TRIGGER invoice_lines_restricted;

ALTER TABLE invoice_lines
  ALTER COLUMN outlet_id     SET NOT NULL,
  ALTER COLUMN document_date SET NOT NULL,
  ADD FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id);

-- Item-wise sales, dead stock and gross margin by item.
CREATE INDEX invoice_lines_item_idx ON invoice_lines (tenant_id, item_id, document_date)
  WHERE item_id IS NOT NULL;
-- Category-wise sales and any outlet-scoped line aggregate.
CREATE INDEX invoice_lines_outlet_idx ON invoice_lines (tenant_id, outlet_id, document_date);


-- ===========================================================================
-- payments: the indexes the cash reports actually use
--
-- payments_customer_idx leads on customer_id, which is NULL for every
-- invoice_tender — that is, for most rows in a retail shop. Day book,
-- payment-mode split and day-close all filter by outlet and time, and none of
-- them can use that index.
-- ===========================================================================

CREATE INDEX payments_outlet_idx ON payments (tenant_id, outlet_id, received_at DESC);
CREATE INDEX payments_mode_idx   ON payments (tenant_id, mode, received_at);

-- Daily P&L and the expense/receipt summaries scan the ledger by time across
-- all customers; the existing statement index leads on customer_id.
CREATE INDEX customer_ledger_time_idx ON customer_ledger_entries (tenant_id, occurred_at);

SELECT app.grant_runtime_privileges();
