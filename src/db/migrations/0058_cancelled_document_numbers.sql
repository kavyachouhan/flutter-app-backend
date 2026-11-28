-- 0058 — Unused reserved numbers, declared cancelled (GSTR-1 Table 13).
--
-- A device reserves a block of numbers so it can bill offline. Numbers it never
-- used cannot be reissued, so until now they stayed in the series as gaps that
-- Table 13 reported as "not accounted for". This table is where the business
-- accounts for them: each row is one number of a block that will never be used,
-- declared cancelled.
--
-- A number is written here only when nothing can still be issued under it:
--   device_removed  its device was deactivated (it can never sync again), or
--   unused_block    its block expired, and the device has been in contact since
--                   (anything it issued has had its chance to arrive) or the
--                   block expired long ago.
-- The service decides that; the database guarantees the rest:
--   * one row per number of a series (a number is cancelled once);
--   * rows are never changed or deleted (a declaration in a filed return stands);
--   * a number with a document is never here: the service checks inside the
--     same transaction, holding the row lock on the block that issuing also takes,
--     and a number written here is refused to any later upload.
--
-- Table 13 reads these as cancelled in the period of cancelled_on, under the
-- family and registration of the series, beside the numbers documents consumed.
--
-- Additive only: one new table.

SET LOCAL search_path = public, extensions;

-- no-tenant-setup: cancelled_document_numbers — server-side declarations read by GSTR-1; never synced
CREATE TABLE cancelled_document_numbers (
  id               UUID        PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES tenants (id),
  series_id        UUID        NOT NULL,
  block_id         UUID        NOT NULL,
  sequence_no      BIGINT      NOT NULL CHECK (sequence_no > 0),
  -- As it would have printed: Rules 46(b), 49, 53.
  document_number  TEXT        NOT NULL CHECK (char_length(document_number) BETWEEN 1 AND 16
                                               AND document_number ~ '^[A-Za-z0-9/-]+$'),
  -- Family and registration of the series when declared: the Table 13 bucket and GSTIN.
  series_family    TEXT        NOT NULL,
  registration_id  UUID,
  -- The day the number stopped being usable, in the calendar of the business: the
  -- period whose Table 13 reports it.
  cancelled_on     DATE        NOT NULL,
  reason           TEXT        NOT NULL CHECK (reason IN ('device_removed', 'unused_block')),
  created_by       UUID        REFERENCES users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (series_id, sequence_no),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id),
  FOREIGN KEY (tenant_id, block_id) REFERENCES number_blocks (tenant_id, id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id)
);
CREATE INDEX cancelled_document_numbers_period_idx
  ON cancelled_document_numbers (tenant_id, registration_id, cancelled_on);
ALTER TABLE cancelled_document_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancelled_document_numbers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cancelled_document_numbers
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
SELECT app.restrict_table('cancelled_document_numbers', ARRAY['UPDATE', 'DELETE']);

SELECT app.grant_runtime_privileges();
