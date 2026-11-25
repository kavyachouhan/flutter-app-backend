-- 0054: advances under GST: receipt vouchers, refund vouchers, adjustments against invoices.
--
-- Law (texts in docs/gst): s.31(3)(d) receipt voucher on receipt of an advance, Rule 50 contents
-- (rate not determinable: 18%; nature not determinable: inter-State). s.31(3)(e) refund voucher
-- when no supply follows, Rule 51. s.12(2)/s.13(2): an advance fixes the time of supply. For goods
-- a regular (non-composition) taxpayer pays tax at the invoice, not the advance (66/2017-CT), so a
-- goods voucher carries no tax. GSTR-1 table 11A (advance received, not invoiced in the period,
-- net of refund vouchers) and 11B (advance adjusted against an invoice of a later period).
--
-- Table contract:
--   receipt_vouchers    one per advance. `amount` is what was received; taxable_amount and the tax
--                       are worked out from it (tax-inclusive) at rate_percent. Numbered per
--                       registration and financial year (RV/yyyy/n), never edited; void only before
--                       the GSTR-1 of its period is filed (checked by the API).
--   refund_vouchers     one per refund of an unadjusted advance (RF/yyyy/n), never edited.
--   advance_adjustments links an invoice to the voucher whose advance it consumes: the taxable
--                       value and tax adjusted. Append-only.
-- Payments are unchanged: a voucher may point at the payment (receipt or order advance) it
-- documents.

SET LOCAL search_path = public, extensions;

CREATE TABLE receipt_vouchers (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  gstin              TEXT        NOT NULL,
  outlet_id          UUID        NOT NULL,
  customer_id        UUID,
  payment_id         UUID,
  fy_start_year      INTEGER     NOT NULL,
  sequence_no        INTEGER     NOT NULL CHECK (sequence_no > 0),
  document_number    TEXT        NOT NULL CHECK (length(document_number) <= 16),
  document_date      DATE        NOT NULL,
  supply_kind        TEXT        NOT NULL CHECK (supply_kind IN ('goods', 'services')),
  place_of_supply    TEXT        NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  supply_type        TEXT        NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  rate_percent       NUMERIC(6, 3) NOT NULL CHECK (rate_percent >= 0),
  rate_determinable  BOOLEAN     NOT NULL DEFAULT true,
  reverse_charge     BOOLEAN     NOT NULL DEFAULT false,
  amount             BIGINT      NOT NULL CHECK (amount > 0),
  taxable_amount     BIGINT      NOT NULL,
  igst               BIGINT      NOT NULL,
  cgst               BIGINT      NOT NULL,
  sgst               BIGINT      NOT NULL,
  cess               BIGINT      NOT NULL DEFAULT 0,
  description        TEXT,
  status             TEXT        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  created_by         UUID        NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, gstin, fy_start_year, sequence_no),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id)
);
CREATE INDEX receipt_vouchers_period_idx ON receipt_vouchers (tenant_id, gstin, document_date);
SELECT app.setup_tenant_table('receipt_vouchers');
SELECT app.restrict_table('receipt_vouchers', ARRAY['DELETE']);
CREATE TRIGGER receipt_vouchers_guard BEFORE UPDATE ON receipt_vouchers FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update('status', 'updated_at', 'server_seq');

CREATE TABLE refund_vouchers (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants (id),
  gstin               TEXT        NOT NULL,
  receipt_voucher_id  UUID        NOT NULL,
  fy_start_year       INTEGER     NOT NULL,
  sequence_no         INTEGER     NOT NULL CHECK (sequence_no > 0),
  document_number     TEXT        NOT NULL CHECK (length(document_number) <= 16),
  document_date       DATE        NOT NULL,
  amount              BIGINT      NOT NULL CHECK (amount > 0),
  taxable_amount      BIGINT      NOT NULL,
  igst                BIGINT      NOT NULL,
  cgst                BIGINT      NOT NULL,
  sgst                BIGINT      NOT NULL,
  cess                BIGINT      NOT NULL DEFAULT 0,
  created_by          UUID        NOT NULL REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq          BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, gstin, fy_start_year, sequence_no),
  FOREIGN KEY (tenant_id, receipt_voucher_id) REFERENCES receipt_vouchers (tenant_id, id)
);
SELECT app.setup_tenant_table('refund_vouchers');
SELECT app.restrict_table('refund_vouchers', ARRAY['UPDATE', 'DELETE']);

CREATE TABLE advance_adjustments (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants (id),
  gstin               TEXT        NOT NULL,
  receipt_voucher_id  UUID        NOT NULL,
  invoice_id          UUID        NOT NULL,
  -- The invoice date: the period the adjustment is reported in (table 11B).
  document_date       DATE        NOT NULL,
  amount              BIGINT      NOT NULL CHECK (amount > 0),
  taxable_amount      BIGINT      NOT NULL,
  igst                BIGINT      NOT NULL,
  cgst                BIGINT      NOT NULL,
  sgst                BIGINT      NOT NULL,
  cess                BIGINT      NOT NULL DEFAULT 0,
  created_by          UUID        NOT NULL REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq          BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_voucher_id, invoice_id),
  FOREIGN KEY (tenant_id, receipt_voucher_id) REFERENCES receipt_vouchers (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
SELECT app.setup_tenant_table('advance_adjustments');
SELECT app.restrict_table('advance_adjustments', ARRAY['UPDATE', 'DELETE']);

SELECT app.grant_runtime_privileges();
