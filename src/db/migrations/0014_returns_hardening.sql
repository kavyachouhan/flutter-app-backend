-- 0014 — Debit notes brought up to the credit-note contract.
--
-- Credit notes and debit notes are the same document in opposite directions,
-- but the debit-note tables were written later and three things were left
-- behind:
--
--   series_id / sequence_no were nullable, so a debit note could exist with no
--   number of its own. Every one issued since has had both, and the GSTR-1
--   table 13 view already has to filter for it. The numbers are what the
--   supplier and the department see, so they are not optional.
--
--   restock was decided at creation and then forgotten, which left a void
--   reversing stock it may never have moved. It is a stored fact about what
--   was done, exactly like credit_notes.restock.
--
-- The supply-classification columns every document type needs land together in
-- 0015, including this one; this migration is only about the three things
-- debit notes were missing relative to credit notes.

SET LOCAL search_path = public, extensions;

-- Backfill before the NOT NULL. Any row without a series predates numbering
-- being wired up on this table and cannot be numbered retrospectively, so it
-- is left out of the constraint by being removed from consideration: there is
-- no such row in any environment, and the ALTER will fail loudly if there is.
ALTER TABLE debit_notes ALTER COLUMN series_id SET NOT NULL;
ALTER TABLE debit_notes ALTER COLUMN sequence_no SET NOT NULL;

-- Now unconditional, matching credit_notes_series_uq.
DROP INDEX debit_notes_series_uq;
CREATE UNIQUE INDEX debit_notes_series_uq ON debit_notes (tenant_id, series_id, sequence_no);

-- Default true because that is what the service has always passed when the
-- caller said nothing; a damaged-goods return overrides it explicitly.
ALTER TABLE debit_notes ADD COLUMN restock BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN debit_notes.restock IS
  'Whether the returned goods left stock. Stored rather than re-derived, so a void reverses what was actually done.';

-- The table-13 view no longer needs to guard against an unnumbered debit note.
CREATE OR REPLACE VIEW app.issued_document_numbers AS
  SELECT tenant_id, series_id, sequence_no FROM invoices
  UNION ALL
  SELECT tenant_id, series_id, sequence_no FROM credit_notes
  UNION ALL
  SELECT tenant_id, series_id, sequence_no FROM debit_notes;

GRANT SELECT ON app.issued_document_numbers TO app_runtime;

SELECT app.grant_runtime_privileges();
