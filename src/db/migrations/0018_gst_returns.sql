-- 0018 — GST returns: GSTR-1 and 3B workings, the ITC register, GSTR-2B
-- reconciliation, and composition.
--
-- This is where a GST-registered shop actually loses money. Not on the filing
-- itself — an accountant does that — but on the credit it never claims because
-- nobody reconciled the purchase register against what suppliers actually
-- filed. A bill the supplier forgot to upload is input tax the shop has paid
-- and cannot reclaim, and it is invisible until someone compares the two.
--
-- Table contracts:
--   gst_return_periods  one row per (GSTIN, return, period); workings snapshotted
--   itc_register        append-only; one row per inward tax event
--   gstr2b_imports      staged portal download, resumable like import_jobs
--   gstr2b_invoices     the portal's own rows, stored verbatim
--   gstr2b_matches      what reconciliation concluded, and why
--
-- Three decisions worth stating.
--
-- **Workings are snapshotted, never recomputed on read.** The same rule as
-- day_closes: a return filed in October must keep reporting what was filed,
-- not what today's data would produce. A void raised afterwards belongs in the
-- next period's amendment tables, not retroactively inside a filed return.
--
-- **Filing is never automatic.** `status` moves open → prepared → filed, and
-- the last step takes an explicit action that records who did it. The product
-- guide is emphatic about this and it is a legal exposure, not a UX
-- preference: the numbers are the shop's declaration, not ours.
--
-- **Returns are per GSTIN, not per tenant.** A business trading in two states
-- holds a registration per state, outlets.gstin overrides the tenant's, and
-- each registration files separately. Scoping any of this by tenant would
-- merge two registrations into one wrong return.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Tenant GST profile: what the returns need and nothing stored
-- ===========================================================================

-- Composition is a flat percentage of turnover, and the percentage depends on
-- what the business does: 1% for a trader or manufacturer, 5% for a
-- restaurant, 6% for a service provider. Without the category there is no
-- CMP-08 to compute.
ALTER TABLE tenants ADD COLUMN composition_category TEXT
  CHECK (composition_category IN ('trader', 'manufacturer', 'restaurant', 'service'));
ALTER TABLE tenants ADD COLUMN composition_rate_percent NUMERIC(5, 2)
  CHECK (composition_rate_percent >= 0);

-- Monthly or quarterly (QRMP) decides which periods exist at all, so a shop
-- is not shown eleven returns it does not have to file.
ALTER TABLE tenants ADD COLUMN filing_frequency TEXT NOT NULL DEFAULT 'monthly'
  CHECK (filing_frequency IN ('monthly', 'qrmp'));

-- Supplies before this date are outside GST for this business, which is what
-- makes the first return after registration correct.
ALTER TABLE tenants ADD COLUMN registration_effective_from DATE;

ALTER TABLE tenants ADD CONSTRAINT tenants_composition_rate_required
  CHECK (NOT is_composition OR composition_rate_percent IS NOT NULL);

COMMENT ON COLUMN tenants.composition_rate_percent IS
  'Flat rate on turnover under the composition scheme. Stored rather than derived from the category, because the notified rates change and an old CMP-08 must keep reporting the rate it was filed at.';

-- ===========================================================================
-- gst_return_periods
-- ===========================================================================

CREATE TABLE gst_return_periods (
  id               UUID        PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES tenants (id),
  -- The registration this return belongs to. Not a foreign key: it is the
  -- GSTIN as filed, and a tenant or outlet may change its GSTIN afterwards
  -- without rewriting history.
  gstin            TEXT        NOT NULL CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  return_type      TEXT        NOT NULL CHECK (return_type IN ('gstr1', 'gstr3b', 'cmp08')),
  period_year      INTEGER     NOT NULL CHECK (period_year BETWEEN 2017 AND 2100),
  -- 1-12 for a month; for QRMP the quarter's last month, so one column orders
  -- every period correctly whatever the frequency.
  period_month     INTEGER     NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  -- The window actually covered, which a quarter needs and a month does not.
  period_from      DATE        NOT NULL,
  period_to        DATE        NOT NULL,

  status           TEXT        NOT NULL CHECK (status IN ('open', 'prepared', 'filed')),
  -- The computed return, snapshotted when prepared. Recomputing on read would
  -- let a void raised in November silently restate October's filed figures.
  workings         JSONB,
  -- Headline figures, lifted out of the workings so a list does not parse it.
  total_taxable    BIGINT,
  total_tax        BIGINT,

  prepared_at      TIMESTAMPTZ,
  prepared_by      UUID        REFERENCES users (id),
  filed_at         TIMESTAMPTZ,
  filed_by         UUID        REFERENCES users (id),
  -- The portal's acknowledgement number, which is the only proof of filing.
  arn              TEXT,
  notes            TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq       BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, gstin, return_type, period_year, period_month),
  CHECK (period_to >= period_from),
  CHECK (status <> 'prepared' OR workings IS NOT NULL),
  CHECK (status <> 'filed' OR (filed_at IS NOT NULL AND filed_by IS NOT NULL))
);

CREATE INDEX gst_return_periods_recent_idx
  ON gst_return_periods (tenant_id, period_year DESC, period_month DESC, return_type);
SELECT app.setup_tenant_table('gst_return_periods');

-- A filed return is a declaration to the department; nothing but an amendment
-- changes it. The guard permits only the fields that legitimately move after
-- preparation.
CREATE TRIGGER gst_return_periods_guard BEFORE UPDATE ON gst_return_periods FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'workings', 'total_taxable', 'total_tax', 'prepared_at', 'prepared_by',
    'filed_at', 'filed_by', 'arn', 'notes', 'updated_at', 'server_seq');

-- ===========================================================================
-- itc_register
-- ===========================================================================

-- One row per inward tax event: a purchase bill claims credit, a debit note
-- reverses part of it. Append-only, because this is the ledger an assessment
-- is defended with — an editable ITC register is worth nothing in a notice.
--
-- A separate table rather than columns on purchase_bills because the credit
-- has its own life: it is claimed in a period that need not be the bill's,
-- reversed later if the supplier never files, and reclaimed if they do.
CREATE TABLE itc_register (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  gstin              TEXT        NOT NULL,
  source_type        TEXT        NOT NULL CHECK (source_type IN ('purchase_bill', 'debit_note')),
  source_id          UUID        NOT NULL,
  supplier_id        UUID,
  supplier_gstin     TEXT,
  document_date      DATE        NOT NULL,

  -- GSTR-3B table 4 requires this split and nothing in the system stored it.
  itc_category       TEXT        NOT NULL CHECK (itc_category IN
                       ('inputs', 'input_services', 'capital_goods', 'ineligible')),
  -- Section 17(5) blocked credits: motor vehicles, club memberships, works
  -- contracts and the rest. Free text because the list is long and changes.
  ineligible_reason  TEXT,
  -- Reverse-charge inward supplies appear on both sides of 3B: a liability to
  -- pay and a credit to claim.
  is_reverse_charge  BOOLEAN     NOT NULL DEFAULT false,

  -- Signed. A debit note reverses credit, so its row carries negatives, and
  -- the register sums to the claimable figure without a CASE on source_type.
  cgst               BIGINT      NOT NULL,
  sgst               BIGINT      NOT NULL,
  igst               BIGINT      NOT NULL,
  cess               BIGINT      NOT NULL,
  taxable_amount     BIGINT      NOT NULL,

  state              TEXT        NOT NULL CHECK (state IN
                       ('available', 'claimed', 'reversed', 'ineligible')),
  -- The period the credit was claimed in, as 'YYYY-MM'. Null until claimed.
  claimed_period     TEXT        CHECK (claimed_period ~ '^[0-9]{4}-[0-9]{2}$'),
  -- The 2B row this was matched to, if any. Null is the interesting case: it
  -- is credit the shop has paid for and the supplier has not reported.
  matched_2b_id      UUID,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  -- One row per source document, so re-posting a bill cannot double the credit.
  UNIQUE (tenant_id, source_type, source_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CHECK (itc_category <> 'ineligible' OR state = 'ineligible')
);

CREATE INDEX itc_register_period_idx ON itc_register (tenant_id, gstin, document_date);
CREATE INDEX itc_register_state_idx ON itc_register (tenant_id, state, document_date);
CREATE INDEX itc_register_supplier_gstin_idx ON itc_register (tenant_id, supplier_gstin)
  WHERE supplier_gstin IS NOT NULL;
SELECT app.setup_tenant_table('itc_register');

-- Matching and claiming move `state`, `claimed_period` and `matched_2b_id`;
-- the amounts and the source never move.
CREATE TRIGGER itc_register_guard BEFORE UPDATE ON itc_register FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'state', 'claimed_period', 'matched_2b_id', 'itc_category', 'ineligible_reason',
    'updated_at', 'server_seq');
SELECT app.restrict_table('itc_register', ARRAY['DELETE']);

-- ===========================================================================
-- gstr2b_imports
-- ===========================================================================

CREATE TABLE gstr2b_imports (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants (id),
  gstin               TEXT        NOT NULL,
  period_year         INTEGER     NOT NULL CHECK (period_year BETWEEN 2017 AND 2100),
  period_month        INTEGER     NOT NULL CHECK (period_month BETWEEN 1 AND 12),

  object_key          TEXT        NOT NULL,
  original_filename   TEXT,
  -- The portal ships JSON; the same statement download is also offered as a
  -- spreadsheet, which some accountants hand over instead.
  format              TEXT        NOT NULL CHECK (format IN ('json', 'xlsx')),

  status              TEXT        NOT NULL CHECK (status IN
                        ('pending', 'ingesting', 'ingested', 'reconciling',
                         'reconciled', 'failed', 'cancelled')),
  -- Cursors, so reconciliation runs in chunks the client drives.
  invoice_count       INTEGER     NOT NULL DEFAULT 0,
  reconciled_up_to    INTEGER     NOT NULL DEFAULT 0,
  exact_count         INTEGER     NOT NULL DEFAULT 0,
  probable_count      INTEGER     NOT NULL DEFAULT 0,
  missing_in_books    INTEGER     NOT NULL DEFAULT 0,
  missing_in_2b       INTEGER     NOT NULL DEFAULT 0,
  mismatch_count      INTEGER     NOT NULL DEFAULT 0,
  error_summary       JSONB,

  created_by          UUID        NOT NULL REFERENCES users (id),
  ingested_at         TIMESTAMPTZ,
  reconciled_at       TIMESTAMPTZ,
  last_progress_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq          BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  CHECK (reconciled_up_to <= invoice_count)
);

CREATE INDEX gstr2b_imports_recent_idx ON gstr2b_imports (tenant_id, created_at DESC, id DESC);
CREATE INDEX gstr2b_imports_period_idx
  ON gstr2b_imports (tenant_id, gstin, period_year DESC, period_month DESC);
SELECT app.setup_tenant_table('gstr2b_imports');

-- ===========================================================================
-- gstr2b_invoices
-- ===========================================================================

-- The portal's own rows, stored as received. Deliberately not normalised into
-- purchase_bills: this is someone else's assertion about what they filed, and
-- the whole value of the feature is in the difference between it and ours.
CREATE TABLE gstr2b_invoices (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants (id),
  import_id           UUID        NOT NULL,
  -- 1-based within the import, so reconciliation can work from a cursor.
  row_no              INTEGER     NOT NULL CHECK (row_no > 0),

  supplier_gstin      TEXT        NOT NULL,
  supplier_name       TEXT,
  invoice_no          TEXT        NOT NULL,
  invoice_date        DATE        NOT NULL,
  -- B2B, credit note, debit note, import of goods, and the reverse-charge
  -- variants. Free-text CHECK-less because the portal adds types.
  document_type       TEXT        NOT NULL DEFAULT 'b2b',
  invoice_value       BIGINT      NOT NULL,
  taxable_amount      BIGINT      NOT NULL,
  cgst                BIGINT      NOT NULL DEFAULT 0,
  sgst                BIGINT      NOT NULL DEFAULT 0,
  igst                BIGINT      NOT NULL DEFAULT 0,
  cess                BIGINT      NOT NULL DEFAULT 0,
  place_of_supply     TEXT,
  is_reverse_charge   BOOLEAN     NOT NULL DEFAULT false,
  -- The portal's own eligibility verdict, which can differ from ours.
  itc_available       BOOLEAN,
  itc_unavailable_reason TEXT,
  -- Which GSTR-1 period the supplier filed it in. A bill of ours dated March
  -- can appear in their April filing, which is why a period-bounded match
  -- alone finds false gaps.
  filed_period        TEXT,
  raw                 JSONB       NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq          BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, import_id, row_no),
  FOREIGN KEY (tenant_id, import_id) REFERENCES gstr2b_imports (tenant_id, id)
);

-- The index the match itself runs on: normalised the same way
-- purchase_bills_supplier_invoice_uq normalises ours.
CREATE INDEX gstr2b_invoices_match_idx
  ON gstr2b_invoices (tenant_id, supplier_gstin, upper(trim(invoice_no)));
CREATE INDEX gstr2b_invoices_import_idx ON gstr2b_invoices (tenant_id, import_id, row_no);
SELECT app.setup_tenant_table('gstr2b_invoices');

-- ===========================================================================
-- gstr2b_matches
-- ===========================================================================

CREATE TABLE gstr2b_matches (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants (id),
  import_id           UUID        NOT NULL,
  -- Exactly one of these is null in the two interesting cases: a 2B row with
  -- no bill of ours, or a bill of ours absent from 2B.
  gstr2b_invoice_id   UUID,
  purchase_bill_id    UUID,

  match_type          TEXT        NOT NULL CHECK (match_type IN
                        ('exact', 'probable', 'missing_in_books', 'missing_in_2b', 'mismatch')),
  -- Which fields disagree, for a mismatch: {field: {ours, theirs}}. The same
  -- shape as audit_log.changes and import_job_rows.diff, so one review screen
  -- renders all three.
  differences         JSONB,
  -- Paise. Signed: positive means 2B shows more tax than our books do.
  tax_difference      BIGINT      NOT NULL DEFAULT 0,

  -- An accepted probable match is a human decision and has to be recorded as
  -- one: the next reconciliation must not undo it.
  accepted_at         TIMESTAMPTZ,
  accepted_by         UUID        REFERENCES users (id),
  note                TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq          BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id)        REFERENCES gstr2b_imports (tenant_id, id),
  FOREIGN KEY (tenant_id, gstr2b_invoice_id) REFERENCES gstr2b_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_bill_id) REFERENCES purchase_bills (tenant_id, id),
  -- A match with neither side is not a match.
  CHECK (gstr2b_invoice_id IS NOT NULL OR purchase_bill_id IS NOT NULL),
  CHECK (match_type <> 'missing_in_books' OR purchase_bill_id IS NULL),
  CHECK (match_type <> 'missing_in_2b' OR gstr2b_invoice_id IS NULL)
);

-- One conclusion per 2B row and one per bill within an import, so a rerun
-- replaces rather than accumulates.
CREATE UNIQUE INDEX gstr2b_matches_invoice_uq
  ON gstr2b_matches (tenant_id, import_id, gstr2b_invoice_id)
  WHERE gstr2b_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX gstr2b_matches_bill_uq
  ON gstr2b_matches (tenant_id, import_id, purchase_bill_id)
  WHERE purchase_bill_id IS NOT NULL;
CREATE INDEX gstr2b_matches_type_idx ON gstr2b_matches (tenant_id, import_id, match_type);
SELECT app.setup_tenant_table('gstr2b_matches');

-- ===========================================================================
-- Purchase bills: what the ITC register needs from them
-- ===========================================================================

ALTER TABLE purchase_bills ADD COLUMN itc_category TEXT
  CHECK (itc_category IN ('inputs', 'input_services', 'capital_goods', 'ineligible'));
ALTER TABLE purchase_bills ADD COLUMN itc_ineligible_reason TEXT;

COMMENT ON COLUMN purchase_bills.itc_category IS
  'GSTR-3B table 4 splits input tax credit four ways and itc_eligible alone cannot fill it. NULL on bills entered before this existed; the register treats those as inputs.';

SELECT app.grant_runtime_privileges();
