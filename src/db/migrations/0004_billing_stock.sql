-- 0004 — Document numbering, invoices, payments, and the stock and customer ledgers.
--
-- Invoices and payments are immutable once issued (corrections are credit
-- notes and reversals); ledgers are append-only. Balances are projections
-- maintained by triggers from the ledgers, never written directly.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Numbering
-- ===========================================================================

CREATE TABLE document_series (
  id                     UUID        PRIMARY KEY,
  tenant_id              UUID        NOT NULL REFERENCES tenants (id),
  outlet_id              UUID        NOT NULL,
  -- NULL for an outlet-wide series.
  counter_id             UUID,
  document_type          TEXT        NOT NULL CHECK (document_type IN ('invoice', 'credit_note', 'debit_note', 'payment_receipt')),
  fy_start_year          INTEGER     NOT NULL,
  prefix                 TEXT        NOT NULL CHECK (prefix ~ '^[A-Za-z0-9-]+$'),
  include_outlet_code    BOOLEAN     NOT NULL,
  include_counter_code   BOOLEAN     NOT NULL,
  include_financial_year BOOLEAN     NOT NULL,
  padding                SMALLINT    NOT NULL CHECK (padding > 0),
  separator              TEXT        NOT NULL CHECK (separator IN ('/', '-')),
  -- Next number to hand out in a lease. Set at creation so a business moving
  -- from another app mid-year continues its existing series.
  next_seq               BIGINT      NOT NULL CHECK (next_seq > 0),
  is_active              BOOLEAN     NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ,
  server_seq             BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counters (tenant_id, id),
  CHECK (counter_id IS NOT NULL OR NOT include_counter_code)
);

CREATE UNIQUE INDEX document_series_scope_uq
  ON document_series (tenant_id, outlet_id, counter_id, document_type, fy_start_year)
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('document_series');


-- A range reserved for one device, so it can issue numbers with no network.
CREATE TABLE number_blocks (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  series_id      UUID        NOT NULL,
  device_id      UUID        NOT NULL,
  start_seq      BIGINT      NOT NULL CHECK (start_seq > 0),
  end_seq        BIGINT      NOT NULL,
  consumed_up_to BIGINT,
  -- After expiry the unused tail is reported as a gap, never reissued.
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq     BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  CHECK (end_seq >= start_seq),
  CHECK (consumed_up_to IS NULL OR consumed_up_to BETWEEN start_seq AND end_seq),
  -- The duplicate-number guarantee in its strongest form: two blocks in one
  -- series can never overlap, whatever the application does.
  EXCLUDE USING gist (series_id WITH =, int8range(start_seq, end_seq, '[]') WITH &&)
);

CREATE INDEX number_blocks_device_idx ON number_blocks (tenant_id, device_id, series_id);
SELECT app.setup_tenant_table('number_blocks');


-- ===========================================================================
-- Invoices
-- ===========================================================================

CREATE TABLE invoices (
  id                         UUID        PRIMARY KEY,
  tenant_id                  UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                  UUID        NOT NULL,
  counter_id                 UUID,
  device_id                  UUID        NOT NULL,
  series_id                  UUID        NOT NULL,
  sequence_no                BIGINT      NOT NULL,
  document_number            TEXT        NOT NULL,
  document_date              DATE        NOT NULL,
  fy_start_year              INTEGER     NOT NULL,

  customer_id                UUID,
  -- Snapshots: the invoice must print the same years later even if the
  -- customer or the business changes their details.
  customer_name              TEXT,
  customer_gstin             TEXT,
  supplier_gstin             TEXT,
  supplier_state_code        TEXT        NOT NULL,
  place_of_supply_state_code TEXT,

  tax_mode                   TEXT        NOT NULL CHECK (tax_mode IN ('gst', 'non_gst', 'composition')),
  supply_type                TEXT        NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  prices_include_tax         BOOLEAN     NOT NULL,
  round_off_enabled          BOOLEAN     NOT NULL,

  -- Paise.
  gross_amount               BIGINT      NOT NULL,
  line_discount_total        BIGINT      NOT NULL,
  bill_discount              JSONB,
  bill_discount_amount       BIGINT      NOT NULL,
  taxable_amount             BIGINT      NOT NULL,
  total_cgst                 BIGINT      NOT NULL,
  total_sgst                 BIGINT      NOT NULL,
  total_igst                 BIGINT      NOT NULL,
  total_cess                 BIGINT      NOT NULL,
  total_tax                  BIGINT      NOT NULL,
  taxable_charges            BIGINT      NOT NULL,
  non_taxable_charges        BIGINT      NOT NULL,
  additional_charges         JSONB       NOT NULL,
  sub_total                  BIGINT      NOT NULL,
  round_off                  BIGINT      NOT NULL,
  grand_total                BIGINT      NOT NULL CHECK (grand_total >= 0),
  tax_summary                JSONB       NOT NULL,
  hsn_summary                JSONB       NOT NULL,

  notes                      TEXT,
  status                     TEXT        NOT NULL CHECK (status IN ('issued', 'void')),
  -- Device clock at billing; created_at is when the server received it.
  issued_at                  TIMESTAMPTZ NOT NULL,
  issued_by                  UUID        NOT NULL REFERENCES users (id),
  void_reason                TEXT,
  voided_at                  TIMESTAMPTZ,
  voided_by                  UUID        REFERENCES users (id),
  print_count                INTEGER     NOT NULL DEFAULT 0,
  printed_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq                 BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, sequence_no),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counters (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

CREATE INDEX invoices_date_idx ON invoices (tenant_id, document_date DESC, id DESC);
CREATE INDEX invoices_customer_idx ON invoices (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
SELECT app.setup_tenant_table('invoices');

CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at', 'updated_at', 'server_seq');
SELECT app.restrict_table('invoices', ARRAY['DELETE']);


CREATE TABLE invoice_lines (
  id                   UUID          PRIMARY KEY,
  tenant_id            UUID          NOT NULL REFERENCES tenants (id),
  invoice_id           UUID          NOT NULL,
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
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  server_seq           BIGINT        NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

SELECT app.setup_tenant_table('invoice_lines');
SELECT app.restrict_table('invoice_lines', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- Payments
-- ===========================================================================

CREATE TABLE payments (
  id              UUID        PRIMARY KEY,
  tenant_id       UUID        NOT NULL REFERENCES tenants (id),
  outlet_id       UUID        NOT NULL,
  customer_id     UUID,
  -- invoice_tender: taken at billing; receipt: collected later against khata.
  kind            TEXT        NOT NULL CHECK (kind IN ('invoice_tender', 'receipt')),
  mode            TEXT        NOT NULL CHECK (mode IN ('cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque')),
  amount          BIGINT      NOT NULL CHECK (amount > 0),
  -- Cash handed over, when more than `amount`; change due is the difference.
  tendered_amount BIGINT      CHECK (tendered_amount >= amount),
  reference       TEXT,
  received_at     TIMESTAMPTZ NOT NULL,
  received_by     UUID        NOT NULL REFERENCES users (id),
  status          TEXT        NOT NULL CHECK (status IN ('issued', 'void')),
  void_reason     TEXT,
  voided_at       TIMESTAMPTZ,
  voided_by       UUID        REFERENCES users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq      BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CHECK (kind = 'invoice_tender' OR customer_id IS NOT NULL),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

CREATE INDEX payments_customer_idx ON payments (tenant_id, customer_id, received_at DESC);
SELECT app.setup_tenant_table('payments');

CREATE TRIGGER payments_guard BEFORE UPDATE ON payments FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update('status', 'void_reason', 'voided_at', 'voided_by', 'updated_at', 'server_seq');
SELECT app.restrict_table('payments', ARRAY['DELETE']);


CREATE TABLE payment_allocations (
  id          UUID        PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  payment_id  UUID        NOT NULL,
  invoice_id  UUID        NOT NULL,
  amount      BIGINT      NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq  BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, payment_id, invoice_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

CREATE INDEX payment_allocations_invoice_idx ON payment_allocations (tenant_id, invoice_id);
SELECT app.setup_tenant_table('payment_allocations');
-- A voided payment's allocations stop counting via the payment's status.
SELECT app.restrict_table('payment_allocations', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- Customer ledger (khata)
-- ===========================================================================

CREATE TABLE customer_ledger_entries (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  customer_id    UUID        NOT NULL,
  entry_type     TEXT        NOT NULL CHECK (entry_type IN
                   ('opening_balance', 'invoice', 'invoice_void', 'payment', 'payment_void')),
  -- Debit increases what the customer owes; credit reduces it. Paise.
  debit          BIGINT      NOT NULL CHECK (debit >= 0),
  credit         BIGINT      NOT NULL CHECK (credit >= 0),
  reference_type TEXT,
  reference_id   UUID,
  occurred_at    TIMESTAMPTZ NOT NULL,
  note           TEXT,
  created_by     UUID        REFERENCES users (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq     BIGINT      NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CHECK ((debit > 0) <> (credit > 0))
);

CREATE INDEX customer_ledger_statement_idx ON customer_ledger_entries (tenant_id, customer_id, occurred_at, id);
SELECT app.setup_tenant_table('customer_ledger_entries');
SELECT app.restrict_table('customer_ledger_entries', ARRAY['UPDATE', 'DELETE']);


CREATE TABLE customer_balances (
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  customer_id UUID        NOT NULL,
  balance     BIGINT      NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq  BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, customer_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);

SELECT app.setup_tenant_table('customer_balances');

CREATE FUNCTION app.apply_customer_ledger_entry() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO customer_balances AS b (tenant_id, customer_id, balance)
  VALUES (NEW.tenant_id, NEW.customer_id, NEW.debit - NEW.credit)
  ON CONFLICT (tenant_id, customer_id) DO UPDATE SET balance = b.balance + EXCLUDED.balance;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_ledger_apply AFTER INSERT ON customer_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.apply_customer_ledger_entry();


-- ===========================================================================
-- Stock ledger
--
-- Stock is never a quantity column that gets overwritten: every movement is a
-- row, which is what makes audits, theft detection and sync recovery possible.
-- ===========================================================================

CREATE TABLE stock_ledger_entries (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  outlet_id      UUID        NOT NULL,
  item_id        UUID        NOT NULL,
  entry_type     TEXT        NOT NULL CHECK (entry_type IN ('opening', 'sale', 'sale_void', 'adjustment')),
  -- Thousandths of a unit; negative leaves stock.
  quantity_delta BIGINT      NOT NULL CHECK (quantity_delta <> 0),
  reason_code    TEXT        CHECK (reason_code IN ('damage', 'theft', 'expiry', 'count_correction', 'opening', 'other')),
  reference_type TEXT,
  reference_id   UUID,
  occurred_at    TIMESTAMPTZ NOT NULL,
  note           TEXT,
  created_by     UUID        REFERENCES users (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq     BIGINT      NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  CHECK (entry_type <> 'adjustment' OR reason_code IS NOT NULL)
);

CREATE INDEX stock_ledger_item_idx ON stock_ledger_entries (tenant_id, outlet_id, item_id, occurred_at, id);
SELECT app.setup_tenant_table('stock_ledger_entries');
SELECT app.restrict_table('stock_ledger_entries', ARRAY['UPDATE', 'DELETE']);


CREATE TABLE stock_balances (
  tenant_id  UUID        NOT NULL REFERENCES tenants (id),
  outlet_id  UUID        NOT NULL,
  item_id    UUID        NOT NULL,
  quantity   BIGINT      NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, outlet_id, item_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

SELECT app.setup_tenant_table('stock_balances');

CREATE FUNCTION app.apply_stock_ledger_entry() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO stock_balances AS b (tenant_id, outlet_id, item_id, quantity)
  VALUES (NEW.tenant_id, NEW.outlet_id, NEW.item_id, NEW.quantity_delta)
  ON CONFLICT (tenant_id, outlet_id, item_id) DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_ledger_apply AFTER INSERT ON stock_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_ledger_entry();

SELECT app.grant_runtime_privileges();
