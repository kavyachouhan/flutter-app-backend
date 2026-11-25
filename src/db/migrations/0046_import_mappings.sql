-- 0046 — Importing customers and suppliers, and remembering column matches.
--
-- Until now an import could only be a price list, and the column matching it
-- guessed was never shown to anyone. A shop moving from Vyapar or myBillBook
-- brings three files (items, customers, suppliers) whose headers are not
-- ours, and should confirm once which of their columns is which — and never
-- again for the next file from the same software.
--
-- Table contracts:
--   import_jobs              gains the file's header row, where its column
--                            matching came from, the outlet opening stock
--                            lands in, and the layout key below.
--   import_job_rows          gains notes (things worth saying that do not
--                            stop a row) and dedupe_keys (what a row that
--                            creates a record claims, so two rows in one file
--                            cannot create the same customer twice).
--   import_column_mappings   one confirmed matching per (kind, header layout).
--                            Upserted when a person confirms the matching
--                            screen; read when the next file has the same
--                            headers. Not a financial record and not part of
--                            the change stream: devices never need it.
--
-- One existing constraint is widened: a customer or supplier row is matched
-- by phone or GSTIN, which import_job_rows.match_rule did not admit.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- import_jobs
-- ===========================================================================

ALTER TABLE import_jobs ADD COLUMN headers JSONB;
ALTER TABLE import_jobs ADD COLUMN layout_key TEXT;
ALTER TABLE import_jobs ADD COLUMN mapping_source TEXT
  CHECK (mapping_source IN ('auto', 'saved', 'confirmed'));
-- Opening stock in an item file is recorded at this outlet. Null for a party
-- import, and for an item import that carries no stock column.
ALTER TABLE import_jobs ADD COLUMN outlet_id UUID;

-- ===========================================================================
-- import_job_rows
-- ===========================================================================

ALTER TABLE import_job_rows ADD COLUMN notes JSONB;
ALTER TABLE import_job_rows ADD COLUMN dedupe_keys TEXT[];

-- destructive-ok: DROP_CONSTRAINT — replaced at once by the wider check below, which admits phone and gstin
ALTER TABLE import_job_rows DROP CONSTRAINT import_job_rows_match_rule_check;
ALTER TABLE import_job_rows ADD CONSTRAINT import_job_rows_match_rule_check
  CHECK (match_rule IN ('code', 'barcode', 'name', 'phone', 'gstin'));

-- ===========================================================================
-- import_column_mappings
-- ===========================================================================

-- no-tenant-setup: import_column_mappings — a per-shop preference for the import screen, never synced to devices
CREATE TABLE import_column_mappings (
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  kind        TEXT        NOT NULL CHECK (kind IN ('items', 'customers', 'suppliers')),
  -- SHA-256 hex of the kind and the file's normalised header row, in order.
  -- Order matters because the mapping is by column position.
  layout_key  TEXT        NOT NULL CHECK (layout_key ~ '^[0-9a-f]{64}$'),
  headers     JSONB       NOT NULL,
  -- Field key to zero-based column index, exactly as the analyse step takes it.
  column_map  JSONB       NOT NULL,
  updated_by  UUID        REFERENCES users (id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, layout_key)
);

ALTER TABLE import_column_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_column_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY import_column_mappings_read ON import_column_mappings FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY import_column_mappings_insert ON import_column_mappings FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY import_column_mappings_update ON import_column_mappings FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

SELECT app.grant_runtime_privileges();
