-- 0003 — Catalogue and customers.

SET LOCAL search_path = public, extensions;

CREATE TABLE categories (
  id          UUID        PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  parent_id   UUID,
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  server_seq  BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES categories (tenant_id, id),
  CHECK (parent_id IS DISTINCT FROM id)
);

CREATE UNIQUE INDEX categories_name_uq ON categories (tenant_id, parent_id, lower(name))
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('categories');


CREATE TABLE items (
  id                 UUID          PRIMARY KEY,
  tenant_id          UUID          NOT NULL REFERENCES tenants (id),
  category_id        UUID,
  item_type          TEXT          NOT NULL CHECK (item_type IN ('goods', 'service')),
  name               TEXT          NOT NULL CHECK (length(trim(name)) > 0),
  code               TEXT,
  -- Alternate names cashiers actually type ("kanda" for onion).
  aliases            TEXT[]        NOT NULL,
  hsn_code           TEXT          CHECK (hsn_code ~ '^[0-9]{4,8}$'),
  tax_rate_percent   NUMERIC(6, 3) NOT NULL CHECK (tax_rate_percent >= 0),
  cess_rate_percent  NUMERIC(6, 3) NOT NULL CHECK (cess_rate_percent >= 0),
  unit               TEXT          NOT NULL,
  -- Paise.
  mrp                BIGINT        CHECK (mrp >= 0),
  sale_price         BIGINT        NOT NULL CHECK (sale_price >= 0),
  purchase_price     BIGINT        CHECK (purchase_price >= 0),
  prices_include_tax BOOLEAN       NOT NULL,
  track_stock        BOOLEAN       NOT NULL,
  -- Thousandths of a unit.
  reorder_level      BIGINT        CHECK (reorder_level >= 0),
  is_active          BOOLEAN       NOT NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  server_seq         BIGINT        NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  -- Services have no stock to track.
  CHECK (item_type = 'goods' OR NOT track_stock)
);

CREATE UNIQUE INDEX items_code_uq ON items (tenant_id, lower(code)) WHERE code IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX items_category_idx ON items (tenant_id, category_id) WHERE deleted_at IS NULL;
-- Keyset pagination orders by (name, id).
CREATE INDEX items_name_idx ON items (tenant_id, name, id) WHERE deleted_at IS NULL;
-- Trigram index makes the ILIKE '%term%' search an index scan.
CREATE INDEX items_name_trgm_idx ON items USING gin (name gin_trgm_ops);
CREATE INDEX items_aliases_idx ON items USING gin (aliases);
SELECT app.setup_tenant_table('items');


-- One item can carry several barcodes (pack sizes, reprinted labels).
CREATE TABLE item_barcodes (
  id          UUID        PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  item_id     UUID        NOT NULL,
  barcode     TEXT        NOT NULL CHECK (length(barcode) > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq  BIGINT      NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id) ON DELETE CASCADE
);

-- Scanning must resolve to exactly one item.
CREATE UNIQUE INDEX item_barcodes_uq ON item_barcodes (tenant_id, barcode);
CREATE INDEX item_barcodes_item_idx ON item_barcodes (tenant_id, item_id);
SELECT app.setup_tenant_table('item_barcodes');


CREATE TABLE customers (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants (id),
  name          TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  phone         TEXT        CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  email         TEXT,
  gstin         TEXT        CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  -- Place of supply for inter-state billing.
  state_code    TEXT        CHECK (state_code ~ '^[0-9]{2}$'),
  address_line1 TEXT,
  address_line2 TEXT,
  city          TEXT,
  pincode       TEXT,
  -- Paise; NULL means no limit.
  credit_limit  BIGINT      CHECK (credit_limit >= 0),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  server_seq    BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

-- Phone is how a shopkeeper finds a customer at the counter.
CREATE UNIQUE INDEX customers_phone_uq ON customers (tenant_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX customers_name_idx ON customers (tenant_id, name, id) WHERE deleted_at IS NULL;
CREATE INDEX customers_name_trgm_idx ON customers USING gin (name gin_trgm_ops);
SELECT app.setup_tenant_table('customers');

SELECT app.grant_runtime_privileges();
