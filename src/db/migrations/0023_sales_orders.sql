-- 0023 — Sales orders, order-advance payments, order->invoice fulfilment link,
-- and edit/delete support for purchase orders.
--
-- Table contracts:
--   sales_orders / _lines   mutable until fulfilled; an order is an intention.
--                           It moves no stock and issues no GST document. The
--                           invoice raised against it does both.
--
-- Status is about fulfilment only (open -> partial -> closed). An advance is a
-- payment fact, held in `payments`, and never changes the status.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Sales orders
-- ===========================================================================

CREATE TABLE sales_orders (
  id                         UUID        PRIMARY KEY,
  tenant_id                  UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                  UUID        NOT NULL,
  series_id                  UUID,
  sequence_no                BIGINT,
  document_number            TEXT        NOT NULL,
  document_date              DATE        NOT NULL,
  fy_start_year              INTEGER     NOT NULL,
  due_date                   DATE,

  customer_id                UUID,
  customer_name              TEXT,
  customer_phone             TEXT,
  place_of_supply_state_code TEXT,

  tax_mode                   TEXT        NOT NULL CHECK (tax_mode IN ('gst', 'non_gst', 'composition')),
  supply_type                TEXT        NOT NULL,
  prices_include_tax         BOOLEAN     NOT NULL,
  round_off_enabled          BOOLEAN     NOT NULL,

  gross_amount               BIGINT      NOT NULL CHECK (gross_amount >= 0),
  line_discount_total        BIGINT      NOT NULL CHECK (line_discount_total >= 0),
  bill_discount              JSONB,
  bill_discount_amount       BIGINT      NOT NULL CHECK (bill_discount_amount >= 0),
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

  -- What the customer paid up front. The money itself lives in `payments`
  -- (kind = 'order_advance'); this is the figure the order shows.
  advance_amount             BIGINT      NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  advance_payment_id         UUID,
  payment_mode               TEXT        CHECK (payment_mode IN
                               ('cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque')),

  notes                      TEXT,
  attachments                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  terms_id                   UUID,
  terms_snapshot             JSONB,

  status                     TEXT        NOT NULL CHECK (status IN ('open', 'partial', 'closed', 'cancelled')),
  -- Set when the user closes an order by hand (short-shipped, customer walked away).
  closed_manually            BOOLEAN     NOT NULL DEFAULT false,
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
  CHECK (advance_amount <= grand_total),
  CHECK (advance_amount = 0 OR customer_id IS NOT NULL),
  CHECK (due_date IS NULL OR due_date >= document_date),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX sales_orders_series_uq ON sales_orders (tenant_id, series_id, sequence_no)
  WHERE series_id IS NOT NULL;
CREATE INDEX sales_orders_list_idx ON sales_orders (tenant_id, document_date DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX sales_orders_status_idx ON sales_orders (tenant_id, outlet_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX sales_orders_customer_idx ON sales_orders (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;
SELECT app.setup_tenant_table('sales_orders');


CREATE TABLE sales_order_lines (
  id                   UUID          PRIMARY KEY,
  tenant_id            UUID          NOT NULL REFERENCES tenants (id),
  sales_order_id       UUID          NOT NULL,
  line_no              INTEGER       NOT NULL,
  item_id              UUID,
  item_name            TEXT          NOT NULL,
  hsn_code             TEXT,
  unit                 TEXT,
  quantity             BIGINT        NOT NULL CHECK (quantity > 0),
  -- Maintained as invoices are raised against the order.
  quantity_fulfilled   BIGINT        NOT NULL DEFAULT 0 CHECK (quantity_fulfilled >= 0),
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
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  CHECK (quantity_fulfilled <= quantity)
);

CREATE INDEX sales_order_lines_order_idx ON sales_order_lines (tenant_id, sales_order_id, line_no);
SELECT app.setup_tenant_table('sales_order_lines');


-- ===========================================================================
-- Fulfilment link: invoice -> order
-- ===========================================================================

ALTER TABLE invoices ADD COLUMN sales_order_id UUID;
ALTER TABLE invoices ADD CONSTRAINT invoices_sales_order_fk
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders (tenant_id, id);
CREATE INDEX invoices_sales_order_idx ON invoices (tenant_id, sales_order_id)
  WHERE sales_order_id IS NOT NULL;

ALTER TABLE invoice_lines ADD COLUMN sales_order_line_id UUID;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_sales_order_line_fk
  FOREIGN KEY (tenant_id, sales_order_line_id) REFERENCES sales_order_lines (tenant_id, id);
CREATE INDEX invoice_lines_sales_order_line_idx ON invoice_lines (tenant_id, sales_order_line_id)
  WHERE sales_order_line_id IS NOT NULL;


-- ===========================================================================
-- Advance payments
-- ===========================================================================

ALTER TABLE payments DROP CONSTRAINT payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check
  CHECK (kind IN ('invoice_tender', 'receipt', 'refund', 'order_advance'));

ALTER TABLE payments ADD COLUMN sales_order_id UUID;
ALTER TABLE payments ADD CONSTRAINT payments_sales_order_fk
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders (tenant_id, id);
ALTER TABLE payments ADD CONSTRAINT payments_order_advance_chk
  CHECK ((kind = 'order_advance') = (sales_order_id IS NOT NULL));
CREATE INDEX payments_sales_order_idx ON payments (tenant_id, sales_order_id)
  WHERE sales_order_id IS NOT NULL;


-- ===========================================================================
-- Purchase orders: edit and delete
-- ===========================================================================

ALTER TABLE purchase_orders ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX purchase_orders_live_idx ON purchase_orders (tenant_id, document_date DESC, id DESC)
  WHERE deleted_at IS NULL;

SELECT app.grant_runtime_privileges();
