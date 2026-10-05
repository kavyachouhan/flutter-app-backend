-- 0010 — Bulk import jobs.
--
-- A shop arriving with an existing price list will not retype 500 items, so
-- importing a spreadsheet is the onboarding unblocker. The design question is
-- not "how do we parse xlsx" but "what happens to a 20,000-row file on a
-- phone with a bad connection".
--
-- The answer is three resumable phases, each advancing a cursor on the job:
--
--   ingest   the file is streamed once and every row is stored raw
--   analyse  rows are validated, matched and diffed, a chunk per call
--   apply    matched rows are written, a chunk per transaction
--
-- Splitting ingest from analyse is what makes chunking affordable: re-opening
-- and skipping through the spreadsheet on every call would be quadratic in
-- the number of chunks, whereas reading cells once and chunking the
-- database-bound work is linear.
--
-- Table contracts:
--   import_jobs      a state machine, mutable, no guard trigger
--   import_job_rows  working set, mutable until applied
--
-- Neither is a financial document. A partially applied catalogue is untidy
-- rather than incorrect, which is why apply is allowed to commit per chunk
-- and resume, and why `applied_at` is per row.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- import_jobs
-- ===========================================================================

CREATE TABLE import_jobs (
  id                     UUID        PRIMARY KEY,
  tenant_id              UUID        NOT NULL REFERENCES tenants (id),

  kind                   TEXT        NOT NULL CHECK (kind IN
                           ('items', 'customers', 'suppliers', 'opening_stock')),
  -- Where the client uploaded the spreadsheet. Purged when the job ends.
  object_key             TEXT        NOT NULL,
  original_filename      TEXT,

  status                 TEXT        NOT NULL CHECK (status IN
                           ('pending', 'ingesting', 'ingested', 'analysing', 'analysed',
                            'applying', 'applied', 'failed', 'cancelled', 'expired')),

  -- Resolved header -> field mapping, so a re-analyse reuses what the user
  -- confirmed on the mapping screen instead of guessing again.
  column_map             JSONB,

  -- The cursors. Everything resumable about this feature lives in these three
  -- integers plus import_job_rows.applied_at.
  ingested_rows          INTEGER     NOT NULL DEFAULT 0 CHECK (ingested_rows >= 0),
  analysed_up_to_row     INTEGER     NOT NULL DEFAULT 0 CHECK (analysed_up_to_row >= 0),
  applied_up_to_row      INTEGER     NOT NULL DEFAULT 0 CHECK (applied_up_to_row >= 0),

  total_rows             INTEGER     NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  create_count           INTEGER     NOT NULL DEFAULT 0,
  update_count           INTEGER     NOT NULL DEFAULT 0,
  skip_count             INTEGER     NOT NULL DEFAULT 0,
  error_count            INTEGER     NOT NULL DEFAULT 0,

  -- Hash of the catalogue's state at analysis. Apply refuses if it moved,
  -- rather than writing a diff computed against rows that no longer exist.
  catalogue_fingerprint  TEXT,
  error_summary          JSONB,

  created_by             UUID        REFERENCES users (id),
  ingested_at            TIMESTAMPTZ,
  analysed_at            TIMESTAMPTZ,
  applied_at             TIMESTAMPTZ,
  -- Bumped by every chunk. A job stuck here is one a client walked away from,
  -- which is the failure mode of driving chunks from the client.
  last_progress_at       TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq             BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  -- A cursor past what was ingested would mean work was claimed on rows that
  -- do not exist.
  CHECK (analysed_up_to_row <= ingested_rows),
  CHECK (applied_up_to_row  <= ingested_rows)
);

CREATE INDEX import_jobs_recent_idx ON import_jobs (tenant_id, created_at DESC, id DESC);
-- Drives "you have an import waiting" and, later, the sweeper.
CREATE INDEX import_jobs_unfinished_idx ON import_jobs (tenant_id, last_progress_at)
  WHERE status IN ('ingesting', 'ingested', 'analysing', 'analysed', 'applying');
SELECT app.setup_tenant_table('import_jobs');


-- ===========================================================================
-- import_job_rows
-- ===========================================================================

CREATE TABLE import_job_rows (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  job_id         UUID        NOT NULL,
  -- 1-based, and the spreadsheet's own row number so an error can be read
  -- against the file the shopkeeper is looking at.
  row_no         INTEGER     NOT NULL CHECK (row_no > 0),

  -- 'pending' at ingest; analyse resolves it.
  action         TEXT        NOT NULL CHECK (action IN
                   ('pending', 'create', 'update', 'skip', 'error')),
  -- Per row, so a resumed apply cannot write the same row twice.
  applied_at     TIMESTAMPTZ,

  -- The existing record this row matched, and which rule found it.
  target_id      UUID,
  match_rule     TEXT        CHECK (match_rule IN ('code', 'barcode', 'name')),

  raw            JSONB       NOT NULL,
  parsed         JSONB,
  -- {field: {from, to}}, populated for an update so the review screen can
  -- show what will actually change.
  diff           JSONB,
  errors         JSONB,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq     BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, job_id, row_no),
  FOREIGN KEY (tenant_id, job_id) REFERENCES import_jobs (tenant_id, id),
  CHECK (action <> 'update' OR target_id IS NOT NULL),
  CHECK (applied_at IS NULL OR action IN ('create', 'update'))
);

-- The review screen, filtered by action.
CREATE INDEX import_job_rows_action_idx ON import_job_rows (tenant_id, job_id, action, row_no);
-- The apply cursor: the next unapplied writable row.
CREATE INDEX import_job_rows_pending_apply_idx ON import_job_rows (tenant_id, job_id, row_no)
  WHERE applied_at IS NULL AND action IN ('create', 'update');
-- Two spreadsheet rows claiming the same existing record is a mistake in the
-- file, not a last-write-wins race. Enforced here so it holds across chunks.
CREATE UNIQUE INDEX import_job_rows_target_uq ON import_job_rows (tenant_id, job_id, target_id)
  WHERE action = 'update';
SELECT app.setup_tenant_table('import_job_rows');

SELECT app.grant_runtime_privileges();
