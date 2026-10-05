-- 0012 — Purchase orders, purchase bills, supplier payments, debit notes.
--
-- Table contracts:
--   purchase_orders / _lines   mutable until received; a PO is an intention
--   purchase_bills / _lines    immutable document (guard + DELETE revoked)
--   supplier_payments / _allocations   immutable, voidable
--   debit_notes / _lines       immutable document (guard + DELETE revoked)
--
-- A purchase bill is immutable like a sales invoice even though the shop
-- typed it rather than issued it. It moves stock, moves cost, and creates a
-- payable; editing one after the fact would mean unwinding a moving average
-- that later sales have already consumed. A mistake is voided and re-entered,
-- which is also what leaves an auditable trail.
--
-- Numbering carries both sides: the supplier's own invoice number (the thing
-- the shopkeeper matches against the paper) and our internal series number
-- (a stable identifier that exists even when the supplier's is missing or
-- duplicated across suppliers).

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Purchase orders
-- ===========================================================================

CREATE TABLE purchase_orders (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  outlet_id          UUID        NOT NULL,
  supplier_id        UUID        NOT NULL,
  series_id          UUID,
  sequence_no        BIGINT,
  document_number    TEXT        NOT NULL,
  document_date      DATE        NOT NULL,
  fy_start_year      INTEGER     NOT NULL,
  expected_date      DATE,
  -- partial once some lines are received, received when all are.
  status             TEXT        NOT NULL CHECK (status IN
                       ('draft', 'sent', 'partial', 'received', 'cancelled')),
  estimated_total    BIGINT      NOT NULL DEFAULT 0 CHECK (estimated_total >= 0),
  notes              TEXT,
  cancelled_reason   TEXT,
  cancelled_at       TIMESTAMPTZ,
  created_by         UUID        NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)   REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id)   REFERENCES document_series (tenant_id, id),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (tenant_id, supplier_id, document_date DESC);
CREATE INDEX purchase_orders_open_idx ON purchase_orders (tenant_id, outlet_id, status)
  WHERE status IN ('sent', 'partial');
SELECT app.setup_tenant_table('purchase_orders');


CREATE TABLE purchase_order_lines (
  id                 UUID          PRIMARY KEY,
  tenant_id          UUID          NOT NULL REFERENCES tenants (id),
  purchase_order_id  UUID          NOT NULL,
  line_no            INTEGER       NOT NULL,
  item_id            UUID          NOT NULL,
  item_name          TEXT          NOT NULL,
  unit               TEXT,
  quantity_ordered   BIGINT        NOT NULL CHECK (quantity_ordered > 0),
  -- Maintained as bills are entered against the order. This column is what
  -- makes partial receipt work.
  quantity_received  BIGINT        NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  expected_unit_cost BIGINT        NOT NULL DEFAULT 0 CHECK (expected_unit_cost >= 0),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  server_seq         BIGINT        NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purchase_order_id, line_no),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

SELECT app.setup_tenant_table('purchase_order_lines');


-- ===========================================================================
-- Purchase bills
-- ===========================================================================

CREATE TABLE purchase_bills (
  id                         UUID        PRIMARY KEY,
  tenant_id                  UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                  UUID        NOT NULL,
  supplier_id                UUID        NOT NULL,
  purchase_order_id          UUID,

  -- Ours.
  series_id                  UUID,
  sequence_no                BIGINT,
  document_number            TEXT        NOT NULL,
  document_date              DATE        NOT NULL,
  fy_start_year              INTEGER     NOT NULL,

  -- Theirs: what is printed on the paper the shopkeeper is holding.
  supplier_invoice_no        TEXT        NOT NULL CHECK (length(trim(supplier_invoice_no)) > 0),
  supplier_invoice_date      DATE        NOT NULL,
  due_date                   DATE,

  supplier_gstin             TEXT,
  supplier_state_code        TEXT,
  place_of_supply_state_code TEXT,

  tax_mode                   TEXT        NOT NULL CHECK (tax_mode IN ('gst', 'non_gst', 'composition')),
  supply_type                TEXT        NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  prices_include_tax         BOOLEAN     NOT NULL,
  round_off_enabled          BOOLEAN     NOT NULL,
  -- Whether the GST on this bill is reclaimable as input tax credit. Decides
  -- whether that tax is capitalised into stock cost, so it is a stored fact
  -- rather than something re-derived from today's registration status.
  itc_eligible               BOOLEAN     NOT NULL,

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
  sub_total                  BIGINT      NOT NULL,
  round_off                  BIGINT      NOT NULL,
  grand_total                BIGINT      NOT NULL CHECK (grand_total >= 0),
  tax_summary                JSONB       NOT NULL,
  hsn_summary                JSONB       NOT NULL,

  -- Capitalised into stock cost per `landed_cost_basis`.
  freight_amount             BIGINT      NOT NULL DEFAULT 0 CHECK (freight_amount >= 0),
  other_charges_amount       BIGINT      NOT NULL DEFAULT 0 CHECK (other_charges_amount >= 0),
  landed_cost_basis          TEXT        NOT NULL CHECK (landed_cost_basis IN ('value', 'quantity', 'none')),

  notes                      TEXT,
  status                     TEXT        NOT NULL CHECK (status IN ('issued', 'void')),
  received_at                TIMESTAMPTZ NOT NULL,
  created_by                 UUID        NOT NULL REFERENCES users (id),
  void_reason                TEXT,
  voided_at                  TIMESTAMPTZ,
  voided_by                  UUID        REFERENCES users (id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq                 BIGINT      NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)         REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)       REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id)         REFERENCES document_series (tenant_id, id),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

-- The double-entry guard. Entering the same supplier bill twice is the most
-- common data-entry error in purchasing, and it silently doubles both stock
-- and the payable. Scoped per supplier and financial year because two
-- suppliers legitimately both have an "INV-001".
CREATE UNIQUE INDEX purchase_bills_supplier_invoice_uq
  ON purchase_bills (tenant_id, supplier_id, upper(trim(supplier_invoice_no)), fy_start_year)
  WHERE status <> 'void';
CREATE UNIQUE INDEX purchase_bills_series_uq
  ON purchase_bills (tenant_id, series_id, sequence_no)
  WHERE series_id IS NOT NULL;
CREATE INDEX purchase_bills_supplier_idx ON purchase_bills (tenant_id, supplier_id, document_date DESC);
CREATE INDEX purchase_bills_date_idx ON purchase_bills (tenant_id, document_date DESC, id DESC);
SELECT app.setup_tenant_table('purchase_bills');

CREATE TRIGGER purchase_bills_guard BEFORE UPDATE ON purchase_bills FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'updated_at', 'server_seq');
SELECT app.restrict_table('purchase_bills', ARRAY['DELETE']);


CREATE TABLE purchase_bill_lines (
  id                   UUID          PRIMARY KEY,
  tenant_id            UUID          NOT NULL REFERENCES tenants (id),
  purchase_bill_id     UUID          NOT NULL,
  purchase_order_line_id UUID,
  outlet_id            UUID          NOT NULL,
  document_date        DATE          NOT NULL,
  line_no              INTEGER       NOT NULL,
  item_id              UUID          NOT NULL,
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
  -- Freight apportioned to this line.
  landed_cost_share    BIGINT        NOT NULL DEFAULT 0,
  -- Paise per whole unit, landed, net of reclaimable tax. The number that
  -- feeds item_costs, snapshotted so a later change of method cannot
  -- silently restate what this receipt cost.
  effective_unit_cost  BIGINT        NOT NULL CHECK (effective_unit_cost >= 0),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  server_seq           BIGINT        NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purchase_bill_id, line_no),
  FOREIGN KEY (tenant_id, purchase_bill_id) REFERENCES purchase_bills (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_line_id) REFERENCES purchase_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);

CREATE INDEX purchase_bill_lines_item_idx ON purchase_bill_lines (tenant_id, item_id, document_date);
SELECT app.setup_tenant_table('purchase_bill_lines');
SELECT app.restrict_table('purchase_bill_lines', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- Supplier payments
-- ===========================================================================

CREATE TABLE supplier_payments (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants (id),
  outlet_id     UUID        NOT NULL,
  supplier_id   UUID        NOT NULL,
  mode          TEXT        NOT NULL CHECK (mode IN
                  ('cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque')),
  amount        BIGINT      NOT NULL CHECK (amount > 0),
  reference     TEXT,
  paid_at       TIMESTAMPTZ NOT NULL,
  paid_by       UUID        NOT NULL REFERENCES users (id),
  status        TEXT        NOT NULL CHECK (status IN ('issued', 'void')),
  notes         TEXT,
  void_reason   TEXT,
  voided_at     TIMESTAMPTZ,
  voided_by     UUID        REFERENCES users (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq    BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id)   REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

CREATE INDEX supplier_payments_supplier_idx ON supplier_payments (tenant_id, supplier_id, paid_at DESC);
SELECT app.setup_tenant_table('supplier_payments');

CREATE TRIGGER supplier_payments_guard BEFORE UPDATE ON supplier_payments FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'updated_at', 'server_seq');
SELECT app.restrict_table('supplier_payments', ARRAY['DELETE']);


CREATE TABLE supplier_payment_allocations (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants (id),
  supplier_payment_id UUID        NOT NULL,
  purchase_bill_id    UUID        NOT NULL,
  amount              BIGINT      NOT NULL CHECK (amount > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq          BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, supplier_payment_id, purchase_bill_id),
  FOREIGN KEY (tenant_id, supplier_payment_id) REFERENCES supplier_payments (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_bill_id)    REFERENCES purchase_bills (tenant_id, id)
);

CREATE INDEX supplier_payment_allocations_bill_idx
  ON supplier_payment_allocations (tenant_id, purchase_bill_id);
SELECT app.setup_tenant_table('supplier_payment_allocations');
SELECT app.restrict_table('supplier_payment_allocations', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- Debit notes (purchase returns)
--
-- A debit note is a GST document the shop issues to its supplier, so unlike
-- a purchase bill it carries only our own number, from a real series.
-- ===========================================================================

CREATE TABLE debit_notes (
  id                         UUID        PRIMARY KEY,
  tenant_id                  UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                  UUID        NOT NULL,
  supplier_id                UUID        NOT NULL,
  purchase_bill_id           UUID        NOT NULL,
  original_document_number   TEXT        NOT NULL,

  series_id                  UUID,
  sequence_no                BIGINT,
  document_number            TEXT        NOT NULL,
  document_date              DATE        NOT NULL,
  fy_start_year              INTEGER     NOT NULL,

  supplier_gstin             TEXT,
  supplier_state_code        TEXT,
  place_of_supply_state_code TEXT,

  tax_mode                   TEXT        NOT NULL CHECK (tax_mode IN ('gst', 'non_gst', 'composition')),
  supply_type                TEXT        NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  prices_include_tax         BOOLEAN     NOT NULL,
  round_off_enabled          BOOLEAN     NOT NULL,

  gross_amount               BIGINT      NOT NULL,
  line_discount_total        BIGINT      NOT NULL,
  bill_discount_amount       BIGINT      NOT NULL,
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

  reason_code                TEXT        NOT NULL CHECK (reason_code IN
                               ('return', 'damaged', 'short_supply', 'rate_difference',
                                'quality', 'expired', 'other')),
  notes                      TEXT,
  status                     TEXT        NOT NULL CHECK (status IN ('issued', 'void')),
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
  FOREIGN KEY (tenant_id, outlet_id)        REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)      REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_bill_id) REFERENCES purchase_bills (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id)        REFERENCES document_series (tenant_id, id),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

CREATE UNIQUE INDEX debit_notes_series_uq ON debit_notes (tenant_id, series_id, sequence_no)
  WHERE series_id IS NOT NULL;
CREATE INDEX debit_notes_bill_idx ON debit_notes (tenant_id, purchase_bill_id);
CREATE INDEX debit_notes_supplier_idx ON debit_notes (tenant_id, supplier_id, document_date DESC);
SELECT app.setup_tenant_table('debit_notes');

CREATE TRIGGER debit_notes_guard BEFORE UPDATE ON debit_notes FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at',
    'updated_at', 'server_seq');
SELECT app.restrict_table('debit_notes', ARRAY['DELETE']);


CREATE TABLE debit_note_lines (
  id                    UUID          PRIMARY KEY,
  tenant_id             UUID          NOT NULL REFERENCES tenants (id),
  debit_note_id         UUID          NOT NULL,
  purchase_bill_line_id UUID          NOT NULL,
  outlet_id             UUID          NOT NULL,
  document_date         DATE          NOT NULL,
  line_no               INTEGER       NOT NULL,
  item_id               UUID          NOT NULL,
  item_name             TEXT          NOT NULL,
  hsn_code              TEXT,
  unit                  TEXT,
  quantity              BIGINT        NOT NULL CHECK (quantity > 0),
  unit_price            BIGINT        NOT NULL CHECK (unit_price >= 0),
  gross_amount          BIGINT        NOT NULL,
  line_discount         BIGINT        NOT NULL,
  taxable_amount        BIGINT        NOT NULL,
  tax_rate_percent      NUMERIC(6, 3) NOT NULL,
  cess_rate_percent     NUMERIC(6, 3) NOT NULL,
  cgst                  BIGINT        NOT NULL,
  sgst                  BIGINT        NOT NULL,
  igst                  BIGINT        NOT NULL,
  cess                  BIGINT        NOT NULL,
  line_total            BIGINT        NOT NULL,
  -- The cost the goods leave at, so stock value unwinds by what it came in
  -- at rather than at today's average.
  effective_unit_cost   BIGINT        NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  server_seq            BIGINT        NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, debit_note_id, line_no),
  FOREIGN KEY (tenant_id, debit_note_id) REFERENCES debit_notes (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_bill_line_id) REFERENCES purchase_bill_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);

-- "How much of this bill line has already been returned" is the check on
-- every new debit note.
CREATE INDEX debit_note_lines_bill_line_idx ON debit_note_lines (tenant_id, purchase_bill_line_id);
SELECT app.setup_tenant_table('debit_note_lines');
SELECT app.restrict_table('debit_note_lines', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- Cost of goods sold, snapshotted onto the sale
-- ===========================================================================

-- Daily P&L has been costing goods at the item's *current* purchase price,
-- which restates history every time a buying price moves. Recording the
-- average in force at the moment of sale turns margin into a historical
-- fact.
--
-- Nullable on purpose: rows written before this migration have no honest
-- value, and reports must say "unknown" rather than show a fabricated
-- margin. invoice_lines forbids UPDATE, so these can never be backfilled —
-- which is correct, because any backfilled figure would be invented.
ALTER TABLE invoice_lines ADD COLUMN cogs_amount BIGINT;

COMMENT ON COLUMN invoice_lines.cogs_amount IS
  'Paise. Moving-average cost at the moment of sale. NULL for lines sold before costing existed; report those as unknown, never as zero.';


-- ===========================================================================
-- GSTR-1 Table 13: every number this business has issued
-- ===========================================================================

-- Purchase bills are excluded deliberately: their series is an internal
-- reference, not a number issued to anyone, so a gap in it is not a GST
-- reporting matter. Debit notes are issued to the supplier and do count.
CREATE OR REPLACE VIEW app.issued_document_numbers AS
  SELECT tenant_id, series_id, sequence_no FROM invoices
  UNION ALL
  SELECT tenant_id, series_id, sequence_no FROM credit_notes
  UNION ALL
  SELECT tenant_id, series_id, sequence_no FROM debit_notes WHERE series_id IS NOT NULL;

GRANT SELECT ON app.issued_document_numbers TO app_runtime;

SELECT app.grant_runtime_privileges();
