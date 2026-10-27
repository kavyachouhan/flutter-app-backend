-- 0019 — Delivery challans.
--
-- Table contracts:
--   delivery_challans / _lines   immutable document (guard + DELETE revoked)
--
-- A challan records goods leaving the shop before a sale is billed (job work,
-- goods sent for approval, a stock transfer run as a challan). It moves stock
-- like a sale does — the goods are physically gone — but it creates no GST
-- invoice value and no customer receivable, because no sale has happened yet.
-- `document_series` already allows 'delivery_challan' (widened in 0007); this
-- migration only adds the two tables themselves.
--
-- Stock reuses the existing 'sale' / 'sale_void' entry types with
-- reference_type = 'delivery_challan' instead of 'invoice' — the same ledger
-- row shape an invoice writes, just tagged with a different source document.
-- No stock_ledger_entries CHECK widening is needed either.
--
-- `quantity_invoiced` on each line exists for the conversion-to-invoice step
-- (not built in this migration) — it lets one challan be billed in more than
-- one invoice without a later schema change.

SET LOCAL search_path = public, extensions;

CREATE TABLE delivery_challans (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  outlet_id          UUID        NOT NULL,
  customer_id        UUID,
  series_id          UUID,
  sequence_no        BIGINT,
  document_number    TEXT        NOT NULL,
  document_date      DATE        NOT NULL,
  fy_start_year      INTEGER     NOT NULL,
  notes              TEXT,
  status             TEXT        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'partial', 'converted', 'cancelled')),
  cancelled_reason   TEXT,
  cancelled_at       TIMESTAMPTZ,
  created_by         UUID        NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)   REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id)   REFERENCES document_series (tenant_id, id),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX delivery_challans_customer_idx ON delivery_challans (tenant_id, customer_id, document_date DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX delivery_challans_open_idx ON delivery_challans (tenant_id, outlet_id, status)
  WHERE status IN ('open', 'partial');
SELECT app.setup_tenant_table('delivery_challans');
SELECT app.restrict_table('delivery_challans', ARRAY['DELETE']);


CREATE TABLE delivery_challan_lines (
  id                   UUID        PRIMARY KEY,
  tenant_id            UUID        NOT NULL REFERENCES tenants (id),
  delivery_challan_id  UUID        NOT NULL,
  line_no              INTEGER     NOT NULL,
  item_id              UUID        NOT NULL,
  item_name            TEXT        NOT NULL,
  unit                 TEXT,
  quantity             BIGINT      NOT NULL CHECK (quantity > 0),
  -- How much of this line has since been billed on an invoice. Stays 0 until
  -- the conversion feature writes it.
  quantity_invoiced    BIGINT      NOT NULL DEFAULT 0 CHECK (quantity_invoiced >= 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq           BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, delivery_challan_id, line_no),
  FOREIGN KEY (tenant_id, delivery_challan_id) REFERENCES delivery_challans (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  CHECK (quantity_invoiced <= quantity)
);

-- UPDATE stays allowed (unlike purchase_bill_lines): quantity_invoiced is
-- written as the conversion feature bills against this line, the same reason
-- purchase_order_lines stays open for quantity_received.
SELECT app.setup_tenant_table('delivery_challan_lines');
SELECT app.restrict_table('delivery_challan_lines', ARRAY['DELETE']);

SELECT app.grant_runtime_privileges();
