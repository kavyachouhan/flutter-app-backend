-- 0020 — Reusable Terms & Conditions.
--
-- A shop keeps a handful of standard terms and attaches one to each sale,
-- purchase or purchase order. The master is mutable and soft-deleted; a
-- document stores both a reference (terms_id) and a snapshot of what the
-- terms said when it was issued, so editing or deleting a T&C later never
-- changes how a past, immutable document reads or reprints.

SET LOCAL search_path = public, extensions;

CREATE TABLE terms_conditions (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  title          TEXT        NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 120),
  description    TEXT        NOT NULL CHECK (length(trim(description)) > 0 AND length(description) <= 2000),
  -- Document types this T&C may be attached to.
  applicable_for TEXT[]      NOT NULL
                 CHECK (cardinality(applicable_for) > 0
                        AND applicable_for <@ ARRAY['sale', 'sale_order', 'purchase', 'purchase_order']::text[]),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  server_seq     BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE INDEX terms_conditions_title_idx ON terms_conditions (tenant_id, title, id)
  WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('terms_conditions');

-- Existing rows keep NULL: documents issued before this migration have no terms.
ALTER TABLE invoices
  ADD COLUMN terms_id       UUID,
  ADD COLUMN terms_snapshot JSONB,
  ADD FOREIGN KEY (tenant_id, terms_id) REFERENCES terms_conditions (tenant_id, id);

ALTER TABLE purchase_bills
  ADD COLUMN terms_id       UUID,
  ADD COLUMN terms_snapshot JSONB,
  ADD FOREIGN KEY (tenant_id, terms_id) REFERENCES terms_conditions (tenant_id, id);

ALTER TABLE purchase_orders
  ADD COLUMN terms_id       UUID,
  ADD COLUMN terms_snapshot JSONB,
  ADD FOREIGN KEY (tenant_id, terms_id) REFERENCES terms_conditions (tenant_id, id);
