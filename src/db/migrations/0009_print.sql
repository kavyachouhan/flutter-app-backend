-- 0009 — Print profiles and custom field definitions.
--
-- `src/domain/print/` has always known how to turn a stored document into a
-- payload a device prints, but the two things it needs from the tenant had no
-- home: the branding and bank/terms block (`PrintProfile`), and the template
-- choice with its handful of overrides (`TemplateOverrides`).
--
-- Table contracts:
--   print_profiles            configuration, mutable, soft-deleted
--   custom_field_definitions  configuration, mutable, soft-deleted
--
-- Neither is a document, so neither gets a guard trigger: a shopkeeper who
-- changes their UPI ID expects the next bill to carry the new one. The values
-- already printed are safe regardless, because every issued document snapshots
-- what it needs at the time it is issued.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- print_profiles
-- ===========================================================================

-- One row per outlet, plus one tenant-wide default (outlet_id IS NULL) that an
-- outlet row inherits from field by field. A single-shop business configures
-- the default and never thinks about this again; a chain overrides only the
-- branch GSTIN and address and keeps one set of terms.
CREATE TABLE print_profiles (
  id                     UUID        PRIMARY KEY,
  tenant_id              UUID        NOT NULL REFERENCES tenants (id),
  -- NULL marks the tenant-wide default.
  outlet_id              UUID,

  template_key           TEXT        NOT NULL CHECK (template_key IN
                           ('thermal_compact', 'thermal_detailed', 'a4_tax', 'a4_tally')),

  -- Tri-state on purpose: NULL inherits the template's own decision, so a
  -- profile written before a template gained a flag keeps working.
  show_hsn               BOOLEAN,
  show_tax_column        BOOLEAN,
  show_tax_summary       BOOLEAN,
  show_amount_in_words   BOOLEAN,
  show_signature         BOOLEAN,

  -- Storage keys, never URLs: a signed URL expires and the printer may be
  -- offline when the bill is reprinted.
  logo_object_key        TEXT,
  signature_object_key   TEXT,
  signature_label        TEXT,
  upi_id                 TEXT        CHECK (upi_id ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z]{1,63}$'),

  bank_lines             TEXT[]      NOT NULL DEFAULT '{}',
  terms_lines            TEXT[]      NOT NULL DEFAULT '{}',
  footer_lines           TEXT[]      NOT NULL DEFAULT '{}',
  -- Appended to the QR so a customer can look the bill up online.
  lookup_base_url        TEXT        CHECK (lookup_base_url ~ '^https://'),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ,
  server_seq             BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  -- A bill that printed 300 lines of terms would be a denial of service on a
  -- roll of thermal paper.
  CHECK (cardinality(bank_lines)   <= 10),
  CHECK (cardinality(terms_lines)  <= 20),
  CHECK (cardinality(footer_lines) <= 10)
);

-- NULLS NOT DISTINCT so the tenant default can exist exactly once.
CREATE UNIQUE INDEX print_profiles_scope_uq
  ON print_profiles (tenant_id, outlet_id)
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('print_profiles');


-- ===========================================================================
-- custom_field_definitions
-- ===========================================================================

-- invoices.custom_fields and credit_notes.custom_fields have accepted an
-- arbitrary JSONB bag since 0007. That was enough to store a vehicle number,
-- but not enough to print one: nothing said what the key is called in the
-- shopkeeper's language, what order the fields go in, or whether a missing one
-- should have blocked the sale. This table is that missing half.
CREATE TABLE custom_field_definitions (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),

  -- The JSONB key. Constrained because it is a wire identifier that older
  -- installed apps will send back for years.
  key            TEXT        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- What the shopkeeper sees, and what prints on the bill.
  label          TEXT        NOT NULL CHECK (length(trim(label)) > 0),

  data_type      TEXT        NOT NULL CHECK (data_type IN ('text', 'number', 'date', 'boolean')),
  is_required    BOOLEAN     NOT NULL DEFAULT false,
  -- Print order. Ties break on key, so the order is always total.
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  -- Which documents the field applies to; a vehicle number belongs on an
  -- invoice and a delivery challan, not on a payment receipt.
  document_types TEXT[]      NOT NULL CHECK (
                   cardinality(document_types) > 0
                   AND document_types <@ ARRAY['invoice', 'credit_note', 'estimate']),
  max_length     INTEGER     CHECK (max_length BETWEEN 1 AND 500),
  placeholder    TEXT,
  is_active      BOOLEAN     NOT NULL DEFAULT true,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  server_seq     BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  -- Only a text field can have a length limit.
  CHECK (max_length IS NULL OR data_type = 'text')
);

CREATE UNIQUE INDEX custom_field_definitions_key_uq
  ON custom_field_definitions (tenant_id, key) WHERE deleted_at IS NULL;
CREATE INDEX custom_field_definitions_order_idx
  ON custom_field_definitions (tenant_id, sort_order, key) WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('custom_field_definitions');

SELECT app.grant_runtime_privileges();
