-- 0007 — Credit notes (returns), refunds, and the widening every later
-- document type needs.
--
-- Table contracts:
--   credit_notes        immutable document (guard + DELETE revoked)
--   credit_note_lines   immutable document detail (UPDATE and DELETE revoked)
--
-- Credit notes get their own tables rather than a discriminator on invoices:
-- payment_allocations reference invoices, invoices CHECK grand_total >= 0, and
-- every sales aggregate would need a predicate whose omission silently doubles
-- a report. The tax engine runs unchanged; only ledger and stock effects invert.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Widen enumerations once, for every planned document type
-- ===========================================================================

ALTER TABLE document_series DROP CONSTRAINT document_series_document_type_check;
ALTER TABLE document_series ADD CONSTRAINT document_series_document_type_check CHECK (document_type IN (
  'invoice', 'credit_note', 'debit_note', 'payment_receipt', 'refund_voucher',
  'purchase_order', 'purchase_bill', 'estimate', 'sales_order', 'delivery_challan',
  'stock_transfer', 'expense'));

ALTER TABLE stock_ledger_entries DROP CONSTRAINT stock_ledger_entries_entry_type_check;
ALTER TABLE stock_ledger_entries ADD CONSTRAINT stock_ledger_entries_entry_type_check CHECK (entry_type IN (
  'opening', 'sale', 'sale_void', 'adjustment',
  'sale_return', 'sale_return_void',
  'purchase', 'purchase_void', 'purchase_return', 'purchase_return_void',
  'transfer_out', 'transfer_in', 'transfer_void', 'count'));

ALTER TABLE customer_ledger_entries DROP CONSTRAINT customer_ledger_entries_entry_type_check;
ALTER TABLE customer_ledger_entries ADD CONSTRAINT customer_ledger_entries_entry_type_check CHECK (entry_type IN (
  'opening_balance', 'invoice', 'invoice_void', 'payment', 'payment_void',
  'credit_note', 'credit_note_void', 'refund', 'refund_void'));

-- A refund is money leaving the till against a credit note. Like a tender it
-- may belong to a walk-in customer, so customer_id stays optional for it.
ALTER TABLE payments DROP CONSTRAINT payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('invoice_tender', 'receipt', 'refund'));
ALTER TABLE payments DROP CONSTRAINT payments_check;
ALTER TABLE payments ADD CONSTRAINT payments_customer_required
  CHECK (kind IN ('invoice_tender', 'refund') OR customer_id IS NOT NULL);
ALTER TABLE payments ADD COLUMN credit_note_id UUID;
CREATE INDEX payments_credit_note_idx ON payments (tenant_id, credit_note_id) WHERE credit_note_id IS NOT NULL;

-- Write-once bag for user-defined fields (vehicle no, PO no...). Not in the
-- guard's mutable list, so it is immutable once issued like the rest.
ALTER TABLE invoices ADD COLUMN custom_fields JSONB;


-- ===========================================================================
-- credit_notes
-- ===========================================================================

CREATE TABLE credit_notes (
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
  original_invoice_id        UUID        NOT NULL,
  original_document_number   TEXT        NOT NULL,

  customer_id                UUID,
  customer_name              TEXT,
  customer_gstin             TEXT,
  supplier_gstin             TEXT,
  supplier_state_code        TEXT        NOT NULL,
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
                               ('return', 'damaged', 'wrong_item', 'price_correction', 'quality', 'other')),
  -- khata credits the customer's ledger; any tender mode pays cash back.
  refund_mode                TEXT        NOT NULL CHECK (refund_mode IN
                               ('khata', 'cash', 'card', 'upi', 'wallet', 'bank_transfer', 'cheque')),
  refund_amount              BIGINT      NOT NULL CHECK (refund_amount >= 0),
  -- Returned goods go back to stock unless they are damaged.
  restock                    BOOLEAN     NOT NULL,
  custom_fields              JSONB,
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
  UNIQUE (tenant_id, series_id, sequence_no),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counters (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id),
  FOREIGN KEY (tenant_id, original_invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CHECK (refund_amount <= grand_total)
);

CREATE INDEX credit_notes_date_idx     ON credit_notes (tenant_id, document_date DESC, id DESC);
CREATE INDEX credit_notes_original_idx ON credit_notes (tenant_id, original_invoice_id);
CREATE INDEX credit_notes_customer_idx ON credit_notes (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
SELECT app.setup_tenant_table('credit_notes');

CREATE TRIGGER credit_notes_guard BEFORE UPDATE ON credit_notes FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at', 'updated_at', 'server_seq');
SELECT app.restrict_table('credit_notes', ARRAY['DELETE']);

ALTER TABLE payments ADD FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id);


CREATE TABLE credit_note_lines (
  id                   UUID          PRIMARY KEY,
  tenant_id            UUID          NOT NULL REFERENCES tenants (id),
  credit_note_id       UUID          NOT NULL,
  invoice_line_id      UUID          NOT NULL,
  outlet_id            UUID          NOT NULL,
  document_date        DATE          NOT NULL,
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
  UNIQUE (tenant_id, credit_note_id, line_no),
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES invoice_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);

-- "How much of this invoice line has already been returned" is the check on
-- every new credit note; the join goes through the credit note's status.
CREATE INDEX credit_note_lines_invoice_line_idx ON credit_note_lines (tenant_id, invoice_line_id);
CREATE INDEX credit_note_lines_item_idx ON credit_note_lines (tenant_id, item_id, document_date) WHERE item_id IS NOT NULL;
CREATE INDEX credit_note_lines_outlet_idx ON credit_note_lines (tenant_id, outlet_id, document_date);
SELECT app.setup_tenant_table('credit_note_lines');
SELECT app.restrict_table('credit_note_lines', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- Issued numbers across every document type, for GSTR-1 Table 13 gaps
-- ===========================================================================

CREATE VIEW app.issued_document_numbers AS
  SELECT tenant_id, series_id, sequence_no FROM invoices
  UNION ALL
  SELECT tenant_id, series_id, sequence_no FROM credit_notes;

GRANT SELECT ON app.issued_document_numbers TO app_runtime;

SELECT app.grant_runtime_privileges();
