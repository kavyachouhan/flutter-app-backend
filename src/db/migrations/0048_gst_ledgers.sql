-- 0048 — Imported GSTN electronic ledgers (cash, return liability, credit reversal and re-claim).
--
-- Table contract:
--   gst_ledger_imports   one row per ledger file accepted: which GSTIN and ledger, the dates the file
--                        says it covers, the parser that read it, a hash of the document (the same
--                        file is never taken twice) and what was found. Append-only.
--   gst_ledger_entries   the entries of those files in neutral form. An entry is one event: the same
--                        entry arriving in an overlapping file is kept once (dedupe_key), so a
--                        half-year file followed by a full-year file never double counts. Append-only.
--
-- Entries are a record of what the portal said. How they are READ (tax paid in cash or through
-- credit) is not stored: it is a rule set in data/gstn-ledger, applied when a return is worked out,
-- so a corrected rule changes the return without touching what was imported.

SET LOCAL search_path = public, extensions;

CREATE TABLE gst_ledger_imports (
  id               UUID        PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES tenants (id),
  gstin            TEXT        NOT NULL CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  kind             TEXT        NOT NULL CHECK (kind IN ('cash', 'liability', 'itc_reversal')),
  period_from      DATE        NOT NULL,
  period_to        DATE        NOT NULL,
  -- The registry id of the parser that read the file, e.g. ledger-cash-v2026.11.
  parser_id        TEXT        NOT NULL,
  sha256           TEXT        NOT NULL,
  entry_count      INTEGER     NOT NULL CHECK (entry_count >= 0),
  -- Entries not seen in an earlier import.
  new_entry_count  INTEGER     NOT NULL CHECK (new_entry_count >= 0),
  issues           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by       UUID        REFERENCES users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq       BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  -- The same document is accepted once per registration and ledger.
  UNIQUE (tenant_id, gstin, kind, sha256),
  CHECK (period_to >= period_from),
  CHECK (new_entry_count <= entry_count)
);

CREATE INDEX gst_ledger_imports_recent_idx ON gst_ledger_imports (tenant_id, gstin, kind, period_from);
SELECT app.setup_tenant_table('gst_ledger_imports');
SELECT app.restrict_table('gst_ledger_imports', ARRAY['UPDATE', 'DELETE']);


CREATE TABLE gst_ledger_entries (
  id               UUID        PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES tenants (id),
  import_id        UUID        NOT NULL,
  gstin            TEXT        NOT NULL,
  kind             TEXT        NOT NULL CHECK (kind IN ('cash', 'liability', 'itc_reversal')),
  -- Position in the first file that carried it.
  row_no           INTEGER     NOT NULL CHECK (row_no >= 0),
  entry_date       DATE,
  return_period    TEXT        CHECK (return_period ~ '^[0-9]{4}-[0-9]{2}$'),
  ref_no           TEXT,
  description      TEXT        NOT NULL,
  direction        TEXT        CHECK (direction IN ('credit', 'debit')),
  discharge_type   TEXT,
  -- Cash and liability: per head, tax / interest / penalty / other / fee, in paise.
  amounts          JSONB,
  -- Credit reversal ledger: reversed (4(B)(2)), reclaimed (4(D)(1)) and availed (4(A)(5)), in paise.
  itc              JSONB,
  -- One event, kept once however many files carry it.
  dedupe_key       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq       BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, gstin, kind, dedupe_key),
  FOREIGN KEY (tenant_id, import_id) REFERENCES gst_ledger_imports (tenant_id, id),
  CHECK ((amounts IS NOT NULL) <> (itc IS NOT NULL))
);

CREATE INDEX gst_ledger_entries_period_idx ON gst_ledger_entries (tenant_id, gstin, kind, return_period, entry_date);
SELECT app.setup_tenant_table('gst_ledger_entries');
SELECT app.restrict_table('gst_ledger_entries', ARRAY['UPDATE', 'DELETE']);

SELECT app.grant_runtime_privileges();
