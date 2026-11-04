-- 0025 — Estimates / quotations.
--
-- Table contracts:
--   estimates / _lines   an offer, not a sale. It moves no stock, takes no GST
--                        invoice number and records no payment. It is mutable while
--                        open; once converted it is frozen and names what it became.
--
-- Status: open -> converted | closed | cancelled. `closed` is a quote that was lost or
-- lapsed; `converted` means a sales order or an invoice was raised from it.
--
-- The link runs both ways: estimates.converted_to_* says what it became, and
-- sales_orders.estimate_id / invoices.estimate_id say where a document came from.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Estimates
-- ===========================================================================

CREATE TABLE estimates (
  id                         UUID        PRIMARY KEY,
  tenant_id                  UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                  UUID        NOT NULL,
  series_id                  UUID,
  sequence_no                BIGINT,
  document_number            TEXT        NOT NULL,
  document_date              DATE        NOT NULL,
  fy_start_year              INTEGER     NOT NULL,
  valid_until                DATE,

  customer_id                UUID,
  customer_name              TEXT,
  customer_phone             TEXT,
  place_of_supply_state_code TEXT,

  tax_mode                   TEXT        NOT NULL CHECK (tax_mode IN ('gst', 'non_gst', 'composition')),
  supply_type                TEXT        NOT NULL,
  prices_include_tax         BOOLEAN     NOT NULL,
  round_off_enabled          BOOLEAN     NOT NULL,
  is_reverse_charge          BOOLEAN     NOT NULL DEFAULT false,

  gross_amount               BIGINT      NOT NULL CHECK (gross_amount >= 0),
  line_discount_total        BIGINT      NOT NULL CHECK (line_discount_total >= 0),
  bill_discount              JSONB,
  bill_discount_amount       BIGINT      NOT NULL CHECK (bill_discount_amount >= 0),
  bill_discount_reason       TEXT,
  additional_charges         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  taxable_charges            BIGINT      NOT NULL DEFAULT 0,
  non_taxable_charges        BIGINT      NOT NULL DEFAULT 0,
  taxable_amount             BIGINT      NOT NULL,
  total_cgst                 BIGINT      NOT NULL,
  total_sgst                 BIGINT      NOT NULL,
  total_igst                 BIGINT      NOT NULL,
  total_cess                 BIGINT      NOT NULL,
  total_tax                  BIGINT      NOT NULL,
  sub_total                  BIGINT      NOT NULL,
  round_off                  BIGINT      NOT NULL,
  grand_total                BIGINT      NOT NULL CHECK (grand_total >= 0),
  tax_summary                JSONB       NOT NULL,
  hsn_summary                JSONB       NOT NULL,

  notes                      TEXT,
  custom_fields              JSONB,
  attachments                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  terms_id                   UUID,
  terms_snapshot             JSONB,

  status                     TEXT        NOT NULL CHECK (status IN ('open', 'converted', 'closed', 'cancelled')),
  converted_to_type          TEXT        CHECK (converted_to_type IN ('sales_order', 'invoice')),
  converted_to_id            UUID,
  converted_at               TIMESTAMPTZ,
  cancelled_reason           TEXT,
  cancelled_at               TIMESTAMPTZ,
  deleted_at                 TIMESTAMPTZ,
  created_by                 UUID        NOT NULL REFERENCES users (id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq                 BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)   REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id)   REFERENCES document_series (tenant_id, id),
  FOREIGN KEY (tenant_id, terms_id)    REFERENCES terms_conditions (tenant_id, id),
  CHECK (valid_until IS NULL OR valid_until >= document_date),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'converted') = (converted_to_type IS NOT NULL)),
  CHECK ((converted_to_type IS NULL) = (converted_to_id IS NULL))
);

CREATE UNIQUE INDEX estimates_series_uq ON estimates (tenant_id, series_id, sequence_no)
  WHERE series_id IS NOT NULL;
CREATE INDEX estimates_list_idx ON estimates (tenant_id, document_date DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX estimates_status_idx ON estimates (tenant_id, outlet_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX estimates_customer_idx ON estimates (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;
SELECT app.setup_tenant_table('estimates');


CREATE TABLE estimate_lines (
  id                   UUID          PRIMARY KEY,
  tenant_id            UUID          NOT NULL REFERENCES tenants (id),
  estimate_id          UUID          NOT NULL,
  line_no              INTEGER       NOT NULL,
  item_id              UUID,
  item_name            TEXT          NOT NULL,
  hsn_code             TEXT,
  unit                 TEXT,
  quantity             BIGINT        NOT NULL CHECK (quantity > 0),
  unit_price           BIGINT        NOT NULL CHECK (unit_price >= 0),
  discount             JSONB,
  gross_amount         BIGINT        NOT NULL,
  line_discount        BIGINT        NOT NULL,
  bill_discount_share  BIGINT        NOT NULL,
  taxable_amount       BIGINT        NOT NULL,
  tax_rate_percent     NUMERIC(6, 3) NOT NULL,
  cess_rate_percent    NUMERIC(6, 3) NOT NULL,
  cgst                 BIGINT        NOT NULL,
  sgst                 BIGINT        NOT NULL,
  igst                 BIGINT        NOT NULL,
  cess                 BIGINT        NOT NULL,
  line_total           BIGINT        NOT NULL,
  supply_category      TEXT          NOT NULL DEFAULT 'taxable',
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  server_seq           BIGINT        NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, estimate_id) REFERENCES estimates (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

CREATE INDEX estimate_lines_estimate_idx ON estimate_lines (tenant_id, estimate_id, line_no);
SELECT app.setup_tenant_table('estimate_lines');


-- ===========================================================================
-- Provenance: where a document came from
-- ===========================================================================

ALTER TABLE sales_orders ADD COLUMN estimate_id UUID;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_estimate_fk
  FOREIGN KEY (tenant_id, estimate_id) REFERENCES estimates (tenant_id, id);
CREATE INDEX sales_orders_estimate_idx ON sales_orders (tenant_id, estimate_id)
  WHERE estimate_id IS NOT NULL;

ALTER TABLE invoices ADD COLUMN estimate_id UUID;
ALTER TABLE invoices ADD CONSTRAINT invoices_estimate_fk
  FOREIGN KEY (tenant_id, estimate_id) REFERENCES estimates (tenant_id, id);
CREATE INDEX invoices_estimate_idx ON invoices (tenant_id, estimate_id)
  WHERE estimate_id IS NOT NULL;


-- ===========================================================================
-- Terms & Conditions: estimates are an applicable document type
-- ===========================================================================

-- The original CHECK is unnamed, so find it by what it says rather than guess a name.
DO $$
DECLARE
  c TEXT;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'terms_conditions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%applicable_for <@%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE terms_conditions DROP CONSTRAINT %I', c);
  END IF;
END $$;
ALTER TABLE terms_conditions ADD CONSTRAINT terms_conditions_applicable_for_check
  CHECK (cardinality(applicable_for) > 0
         AND applicable_for <@ ARRAY['sale', 'sale_order', 'purchase', 'purchase_order', 'estimate']::text[]);

SELECT app.grant_runtime_privileges();
