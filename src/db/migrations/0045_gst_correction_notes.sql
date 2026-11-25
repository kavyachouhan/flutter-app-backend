-- 0045 — The other notes of the correction matrix (D10, D27; freeze §4.2).
--
-- Table contract:
--   credit_note_lines        gains adjustment_kind. A 'quantity' line is a return, as before. A
--                            'value' or 'tax' line credits value or tax with no goods moving, and
--                            so holds quantity 0: everything that sums returned quantity stays right.
--   sales_debit_notes        an outward debit note or supplementary invoice (s.34(3)): value or tax
--                            added to an issued invoice. Its own series; immutable; feeds GSTR-1.
--   sales_debit_note_lines   each against one invoice line.
--   financial_credit_notes   a commercial credit, in its own series, with no tax columns at all. It
--                            never reaches a return (freeze §4.2).
--
-- Both new documents move only the customer's khata: no goods move on either.

SET LOCAL search_path = public, extensions;

-- destructive-ok: DROP_CONSTRAINT — replaced on the next lines by a rule that also allows value lines
ALTER TABLE credit_note_lines DROP CONSTRAINT credit_note_lines_quantity_check;
ALTER TABLE credit_note_lines ADD COLUMN adjustment_kind TEXT NOT NULL DEFAULT 'quantity'
  CHECK (adjustment_kind IN ('quantity', 'value', 'tax'));
ALTER TABLE credit_note_lines ADD CONSTRAINT credit_note_lines_kind_quantity
  CHECK ((adjustment_kind = 'quantity') = (quantity > 0) AND quantity >= 0);

-- destructive-ok: DROP_CONSTRAINT — replaced on the next line by a wider list
ALTER TABLE customer_ledger_entries DROP CONSTRAINT customer_ledger_entries_entry_type_check;
ALTER TABLE customer_ledger_entries ADD CONSTRAINT customer_ledger_entries_entry_type_check CHECK (entry_type IN (
  'opening_balance', 'invoice', 'invoice_void', 'payment', 'payment_void',
  'credit_note', 'credit_note_void', 'refund', 'refund_void',
  'sales_debit_note', 'sales_debit_note_void', 'financial_credit_note', 'financial_credit_note_void'));

CREATE TABLE sales_debit_notes (
  id                         UUID        PRIMARY KEY,
  tenant_id                  UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                  UUID        NOT NULL,
  counter_id                 UUID,
  device_id                  UUID,
  series_id                  UUID        NOT NULL,
  sequence_no                BIGINT      NOT NULL,
  document_number            TEXT        NOT NULL,
  document_date              DATE        NOT NULL,
  fy_start_year              INTEGER     NOT NULL,
  original_invoice_id        UUID        NOT NULL,
  original_document_number   TEXT        NOT NULL,
  original_document_date     DATE        NOT NULL,
  customer_id                UUID        NOT NULL,
  customer_name              TEXT,
  customer_gstin             TEXT,
  customer_uin               TEXT,
  supplier_gstin             TEXT,
  supplier_state_code        TEXT        NOT NULL,
  place_of_supply_state_code TEXT,
  tax_mode                   TEXT        NOT NULL CHECK (tax_mode IN ('gst', 'non_gst', 'composition')),
  supply_type                TEXT        NOT NULL,
  round_off_enabled          BOOLEAN     NOT NULL,
  gross_amount               BIGINT      NOT NULL,
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
  correction_reason          TEXT        NOT NULL CHECK (correction_reason IN ('value_increase', 'tax_undercharged')),
  is_reverse_charge          BOOLEAN     NOT NULL,
  tax_payable_by             TEXT        NOT NULL CHECK (tax_payable_by IN ('supplier', 'recipient')),
  registration_id            UUID,
  registration_resolution    TEXT        NOT NULL
                             CHECK (registration_resolution IN ('resolved', 'non_gst', 'legacy_unresolved')),
  document_type              TEXT,
  supply_scenario            TEXT,
  pos_provision              TEXT,
  sez_authorised_operations  BOOLEAN,
  lut_reference              TEXT,
  buyer_gst_treatment        TEXT,
  seller_snapshot            JSONB,
  buyer_snapshot             JSONB,
  ship_to_snapshot           JSONB,
  dispatch_from_snapshot     JSONB,
  irn_state                  TEXT        NOT NULL DEFAULT 'not_required',
  sync_classification        TEXT        NOT NULL DEFAULT 'server_created',
  notes                      TEXT,
  status                     TEXT        NOT NULL CHECK (status IN ('pending_irn', 'issued', 'void', 'withdrawn')),
  issued_at                  TIMESTAMPTZ NOT NULL,
  issued_by                  UUID        NOT NULL,
  void_reason                TEXT,
  voided_at                  TIMESTAMPTZ,
  voided_by                  UUID,
  print_count                INTEGER     NOT NULL DEFAULT 0,
  printed_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq                 BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, sequence_no),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, original_invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id),
  CONSTRAINT sales_debit_notes_void_fields CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL))
);
CREATE INDEX sales_debit_notes_date_idx ON sales_debit_notes (tenant_id, document_date DESC, id DESC);
CREATE INDEX sales_debit_notes_original_idx ON sales_debit_notes (tenant_id, original_invoice_id);
SELECT app.setup_tenant_table('sales_debit_notes');
CREATE TRIGGER sales_debit_notes_guard BEFORE UPDATE ON sales_debit_notes FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at', 'updated_at', 'server_seq', 'irn_state');
SELECT app.restrict_table('sales_debit_notes', ARRAY['DELETE']);

CREATE TABLE sales_debit_note_lines (
  id                  UUID          PRIMARY KEY,
  tenant_id           UUID          NOT NULL REFERENCES tenants (id),
  sales_debit_note_id UUID          NOT NULL,
  invoice_line_id     UUID          NOT NULL,
  outlet_id           UUID          NOT NULL,
  document_date       DATE          NOT NULL,
  line_no             INTEGER       NOT NULL,
  item_id             UUID,
  item_name           TEXT          NOT NULL,
  hsn_code            TEXT,
  unit                TEXT,
  adjustment_kind     TEXT          NOT NULL CHECK (adjustment_kind IN ('value', 'tax')),
  taxable_amount      BIGINT        NOT NULL,
  tax_rate_percent    NUMERIC(6, 3) NOT NULL,
  cess_rate_percent   NUMERIC(6, 3) NOT NULL,
  cgst                BIGINT        NOT NULL,
  sgst                BIGINT        NOT NULL,
  igst                BIGINT        NOT NULL,
  cess                BIGINT        NOT NULL,
  line_total          BIGINT        NOT NULL,
  supply_category     TEXT          NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  server_seq          BIGINT        NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, sales_debit_note_id, line_no),
  FOREIGN KEY (tenant_id, sales_debit_note_id) REFERENCES sales_debit_notes (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES invoice_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);
SELECT app.setup_tenant_table('sales_debit_note_lines');
SELECT app.restrict_table('sales_debit_note_lines', ARRAY['UPDATE', 'DELETE']);

CREATE TABLE financial_credit_notes (
  id                       UUID        PRIMARY KEY,
  tenant_id                UUID        NOT NULL REFERENCES tenants (id),
  outlet_id                UUID        NOT NULL,
  device_id                UUID,
  series_id                UUID        NOT NULL,
  sequence_no              BIGINT      NOT NULL,
  document_number          TEXT        NOT NULL,
  document_date            DATE        NOT NULL,
  fy_start_year            INTEGER     NOT NULL,
  original_invoice_id      UUID,
  original_document_number TEXT,
  customer_id              UUID        NOT NULL,
  customer_name            TEXT,
  amount                   BIGINT      NOT NULL CHECK (amount > 0),
  reason                   TEXT        NOT NULL,
  notes                    TEXT,
  seller_snapshot          JSONB,
  buyer_snapshot           JSONB,
  status                   TEXT        NOT NULL CHECK (status IN ('issued', 'void')),
  issued_at                TIMESTAMPTZ NOT NULL,
  issued_by                UUID        NOT NULL,
  void_reason              TEXT,
  voided_at                TIMESTAMPTZ,
  voided_by                UUID,
  print_count              INTEGER     NOT NULL DEFAULT 0,
  printed_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq               BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, sequence_no),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, original_invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id)
);
CREATE INDEX financial_credit_notes_date_idx ON financial_credit_notes (tenant_id, document_date DESC, id DESC);
SELECT app.setup_tenant_table('financial_credit_notes');
CREATE TRIGGER financial_credit_notes_guard BEFORE UPDATE ON financial_credit_notes FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at', 'updated_at', 'server_seq');
SELECT app.restrict_table('financial_credit_notes', ARRAY['DELETE']);

-- The number registry (B16) also covers sales debit notes. Otherwise unchanged from 0042.
CREATE OR REPLACE FUNCTION app.register_gst_document_number() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  family TEXT := 'credit_note';
BEGIN
  IF NEW.registration_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'invoices' THEN
      family := CASE WHEN NEW.document_type = 'bill_of_supply' THEN 'bill_of_supply' ELSE 'outward_invoice' END;
    ELSIF TG_TABLE_NAME = 'sales_debit_notes' THEN
      family := 'debit_note_outward';
    END IF;
    INSERT INTO gst_document_numbers (tenant_id, registration_id, fy_start_year, series_family, document_number,
                                      number_state, document_table, document_id)
    VALUES (NEW.tenant_id, NEW.registration_id, NEW.fy_start_year,
            family,
            NEW.document_number, app.gst_number_state(NEW.status), TG_TABLE_NAME, NEW.id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE gst_document_numbers
       SET number_state = app.gst_number_state(NEW.status), updated_at = now()
     WHERE document_table = TG_TABLE_NAME AND document_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sales_debit_notes_gst_number AFTER INSERT OR UPDATE OF status ON sales_debit_notes
  FOR EACH ROW EXECUTE FUNCTION app.register_gst_document_number();

SELECT app.grant_runtime_privileges();
