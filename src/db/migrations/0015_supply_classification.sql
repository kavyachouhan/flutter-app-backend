-- 0015 — How a supply is classified, which the return asks for and the
-- documents could not say.
--
-- Until now a line carried a tax rate and nothing else, so a zero-rate line
-- was ambiguous four ways: a taxable good notified at 0%, an exempt supply, a
-- nil-rated one, or one outside GST altogether. GSTR-1 table 8 and GSTR-3B
-- table 3.1 report those separately, and no amount of re-reading the rate
-- recovers which was meant. The same gap covered reverse charge (reported at
-- value with no tax on the document) and exports and SEZ supplies, which the
-- two-value supply_type CHECK could not express at all.
--
-- These land now rather than when the returns are built, because issued
-- documents are immutable: a classification missing today could never be
-- filled in, and every invoice raised in the meantime would have to be
-- reclassified by hand at filing time.
--
-- Defaults are chosen so nothing changes for documents already issued: every
-- existing line was a taxable supply, and no existing document was under
-- reverse charge. The tax engine treats an absent classification identically,
-- so the frozen contract vectors moved only where a line has no HSN code.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Line classification
-- ===========================================================================

-- A plain ADD COLUMN with a DEFAULT is metadata-only in PostgreSQL 11+, so
-- this does not rewrite the table and does not fire the server_seq trigger.
-- That matters: re-stamping invoice_lines would burn one sequence value per
-- line against the single per-tenant counter and republish the whole sales
-- history of the shop to every device.
ALTER TABLE invoice_lines       ADD COLUMN supply_category TEXT NOT NULL DEFAULT 'taxable';
ALTER TABLE credit_note_lines   ADD COLUMN supply_category TEXT NOT NULL DEFAULT 'taxable';
ALTER TABLE purchase_bill_lines ADD COLUMN supply_category TEXT NOT NULL DEFAULT 'taxable';
ALTER TABLE debit_note_lines    ADD COLUMN supply_category TEXT NOT NULL DEFAULT 'taxable';

ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_supply_category_check
  CHECK (supply_category IN ('taxable', 'exempt', 'nil_rated', 'non_gst'));
ALTER TABLE credit_note_lines ADD CONSTRAINT credit_note_lines_supply_category_check
  CHECK (supply_category IN ('taxable', 'exempt', 'nil_rated', 'non_gst'));
ALTER TABLE purchase_bill_lines ADD CONSTRAINT purchase_bill_lines_supply_category_check
  CHECK (supply_category IN ('taxable', 'exempt', 'nil_rated', 'non_gst'));
ALTER TABLE debit_note_lines ADD CONSTRAINT debit_note_lines_supply_category_check
  CHECK (supply_category IN ('taxable', 'exempt', 'nil_rated', 'non_gst'));

COMMENT ON COLUMN invoice_lines.supply_category IS
  'Classification for the return, not the rate. A 0% taxable line and an exempt line look identical by rate and are reported in different tables.';

-- The catalogue carries the default, so a till is not asked to classify every
-- line it bills.
ALTER TABLE items ADD COLUMN supply_category TEXT NOT NULL DEFAULT 'taxable';
ALTER TABLE items ADD CONSTRAINT items_supply_category_check
  CHECK (supply_category IN ('taxable', 'exempt', 'nil_rated', 'non_gst'));

-- ===========================================================================
-- Document level: reverse charge, exports and SEZ
-- ===========================================================================

ALTER TABLE invoices       ADD COLUMN is_reverse_charge BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE credit_notes   ADD COLUMN is_reverse_charge BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE purchase_bills ADD COLUMN is_reverse_charge BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE debit_notes    ADD COLUMN is_reverse_charge BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN purchase_bills.is_reverse_charge IS
  'The recipient pays the tax. On an inward supply this creates a self-assessed liability and a matching input credit, so it is reported on both sides of GSTR-3B.';

-- An export or SEZ supply is zero-rated either with or without payment of
-- tax; neither is derivable from a state code, so the document must say which.
ALTER TABLE invoices DROP CONSTRAINT invoices_supply_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_supply_type_check CHECK (supply_type IN (
  'intra_state', 'inter_state',
  'export_with_tax', 'export_without_tax', 'sez_with_tax', 'sez_without_tax'));

ALTER TABLE credit_notes DROP CONSTRAINT credit_notes_supply_type_check;
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_supply_type_check CHECK (supply_type IN (
  'intra_state', 'inter_state',
  'export_with_tax', 'export_without_tax', 'sez_with_tax', 'sez_without_tax'));

ALTER TABLE purchase_bills DROP CONSTRAINT purchase_bills_supply_type_check;
ALTER TABLE purchase_bills ADD CONSTRAINT purchase_bills_supply_type_check CHECK (supply_type IN (
  'intra_state', 'inter_state',
  'export_with_tax', 'export_without_tax', 'sez_with_tax', 'sez_without_tax'));

ALTER TABLE debit_notes DROP CONSTRAINT debit_notes_supply_type_check;
ALTER TABLE debit_notes ADD CONSTRAINT debit_notes_supply_type_check CHECK (supply_type IN (
  'intra_state', 'inter_state',
  'export_with_tax', 'export_without_tax', 'sez_with_tax', 'sez_without_tax'));

-- ===========================================================================
-- Suppliers: what GSTR-2B reconciliation matches on
-- ===========================================================================

-- Whether a supplier was expected to appear in 2B at all. A composition or
-- unregistered supplier files nothing, so its bills being absent from 2B is
-- the correct outcome and must not be reported as a gap to chase.
ALTER TABLE suppliers ADD COLUMN registration_type TEXT NOT NULL DEFAULT 'regular';
ALTER TABLE suppliers ADD CONSTRAINT suppliers_registration_type_check
  CHECK (registration_type IN ('regular', 'composition', 'unregistered'));

-- Reconciliation matches on supplier GSTIN and there was no index on it.
-- Not unique: two supplier rows legitimately share a GSTIN (a head office and
-- a depot keyed in separately), and the match has to cope with that.
CREATE INDEX suppliers_gstin_idx ON suppliers (tenant_id, gstin) WHERE gstin IS NOT NULL;

-- The same match reads the snapshot on the bill rather than the master,
-- because the GSTIN of the supplier may have changed since.
CREATE INDEX purchase_bills_supplier_gstin_idx
  ON purchase_bills (tenant_id, supplier_gstin, supplier_invoice_date)
  WHERE supplier_gstin IS NOT NULL;

SELECT app.grant_runtime_privileges();
