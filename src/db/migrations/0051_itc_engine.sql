-- 0051: input tax credit engine (milestone A7, decisions D17, D25, D26).
--
-- Table contract:
--   purchase_bills.itc_use              how the purchase is used, for Rule 42/43: business_taxable,
--                                       common, common_with_non_business, exempt_only, non_business.
--   purchase_bills.blocked_credit_code  the s.17(5) clause that blocks the credit, or null. Free-text
--                                       itc_ineligible_reason stays as the shop's note.
--     Both, with goods_received_date / receipt_complete / services_received_date (0039), can be
--     corrected after entry until the credit has been claimed in a filed GSTR-3B (checked by the API).
--   itc_movements        append-only. What each filed GSTR-3B did with credit, per document:
--                        claim, reverse_permanent, reverse_temporary, reclaim, ineligible, with the
--                        rule and the Table 4 line. Written only when a GSTR-3B is recorded as filed,
--                        from that return's prepared workings; a prepared return only proposes them.
--                        register_id is null for period-level reversals (Rule 42 D1/D2, Rule 43 Te).
--   ims_actions          append-only. The shop's IMS decision on a GSTR-2B / IMS record (accept,
--                        reject, pending, no_action) and, for credit notes, the ITC reduction
--                        declared. The latest row per document is the current decision. Exported as
--                        the IMS Offline Utility v2.0 upload JSON; uploading is done on the portal.
--   gst_statement_balances  append-only. Opening or closing balances of the Electronic Credit
--                        Reversal and Re-claimed Statement (ecrrs) and the RCM Liability/ITC
--                        Statement (rcm), as declared by the shop or read from a portal file.
--   rcm_self_invoices    one per reverse-charge purchase bill from an unregistered supplier or an
--                        import of services: the invoice the recipient issues (s.31(3)(f), within
--                        30 days of receipt, Rule 47A). From 01.11.2024 its date is the time of
--                        supply (s.13(3)(c)). Numbered per registration and financial year.
--
-- No existing data is changed; new columns take defaults that keep every current figure.

SET LOCAL search_path = public, extensions;

ALTER TABLE purchase_bills
  ADD COLUMN itc_use TEXT NOT NULL DEFAULT 'business_taxable'
    CHECK (itc_use IN ('business_taxable', 'common', 'common_with_non_business', 'exempt_only', 'non_business')),
  ADD COLUMN blocked_credit_code TEXT
    CHECK (blocked_credit_code IN ('s17_5_a', 's17_5_aa', 's17_5_ab', 's17_5_b_i', 's17_5_b_ii',
      's17_5_b_iii', 's17_5_c', 's17_5_d', 's17_5_e', 's17_5_f', 's17_5_fa', 's17_5_g', 's17_5_h',
      's17_5_i'));

-- destructive-ok: DROP_TRIGGER — recreated immediately with the ITC classification columns allowed
DROP TRIGGER purchase_bills_guard ON purchase_bills;
CREATE TRIGGER purchase_bills_guard BEFORE UPDATE ON purchase_bills FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'updated_at', 'server_seq',
    'registration_id', 'registration_resolution', 'goods_received_date', 'receipt_complete', 'services_received_date',
    'itc_use', 'blocked_credit_code');

CREATE TABLE itc_movements (
  id                UUID        PRIMARY KEY,
  tenant_id         UUID        NOT NULL REFERENCES tenants (id),
  gstin             TEXT        NOT NULL,
  -- The filed GSTR-3B that made the movement, and its period ('YYYY-MM').
  return_period_id  UUID        NOT NULL,
  period            TEXT        NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  register_id       UUID,
  kind              TEXT        NOT NULL CHECK (kind IN
                      ('claim', 'reverse_permanent', 'reverse_temporary', 'reclaim', 'ineligible')),
  rule              TEXT        NOT NULL CHECK (rule IN
                      ('none', 's17_5', 'rule_37', 'rule_37a', 'rule_42', 'rule_43', 's16_4',
                       'not_available_in_2b')),
  table4_line       TEXT        NOT NULL CHECK (table4_line IN
                      ('a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'd1', 'd2')),
  igst              BIGINT      NOT NULL,
  cgst              BIGINT      NOT NULL,
  sgst              BIGINT      NOT NULL,
  cess              BIGINT      NOT NULL,
  note              TEXT,
  created_by        UUID        NOT NULL REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq        BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, return_period_id) REFERENCES gst_return_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES itc_register (tenant_id, id)
);
CREATE INDEX itc_movements_register_idx ON itc_movements (tenant_id, register_id);
CREATE INDEX itc_movements_period_idx ON itc_movements (tenant_id, gstin, period);
SELECT app.setup_tenant_table('itc_movements');
SELECT app.restrict_table('itc_movements', ARRAY['UPDATE', 'DELETE']);

CREATE TABLE ims_actions (
  id                     UUID        PRIMARY KEY,
  tenant_id              UUID        NOT NULL REFERENCES tenants (id),
  gstin                  TEXT        NOT NULL,
  -- The IMS section the record is in: b2b, b2ba, b2bdn, b2bdna, b2bcn, b2bcna, ecom, ecoma.
  section                TEXT        NOT NULL CHECK (section IN
                           ('b2b', 'b2ba', 'b2bdn', 'b2bdna', 'b2bcn', 'b2bcna', 'ecom', 'ecoma')),
  supplier_gstin         TEXT        NOT NULL,
  document_number        TEXT        NOT NULL,
  document_date          DATE        NOT NULL,
  document_value         BIGINT,
  gstr2b_invoice_id      UUID,
  purchase_bill_id       UUID,
  action                 TEXT        NOT NULL CHECK (action IN ('accept', 'reject', 'pending', 'no_action')),
  itc_reduction_required BOOLEAN,
  declared_igst          BIGINT,
  declared_cgst          BIGINT,
  declared_sgst          BIGINT,
  declared_cess          BIGINT,
  remarks                TEXT        CHECK (length(remarks) <= 250),
  decided_by             UUID        NOT NULL REFERENCES users (id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq             BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, gstr2b_invoice_id) REFERENCES gstr2b_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_bill_id) REFERENCES purchase_bills (tenant_id, id),
  -- ITC reduction is declared only on accepted credit notes and downward amendments.
  CHECK (itc_reduction_required IS NULL OR action = 'accept'),
  CHECK (remarks IS NULL OR action IN ('reject', 'pending'))
);
CREATE INDEX ims_actions_doc_idx
  ON ims_actions (tenant_id, gstin, supplier_gstin, upper(trim(document_number)), created_at DESC);
SELECT app.setup_tenant_table('ims_actions');
SELECT app.restrict_table('ims_actions', ARRAY['UPDATE', 'DELETE']);

CREATE TABLE gst_statement_balances (
  id           UUID        PRIMARY KEY,
  tenant_id    UUID        NOT NULL REFERENCES tenants (id),
  gstin        TEXT        NOT NULL,
  statement    TEXT        NOT NULL CHECK (statement IN ('ecrrs', 'rcm')),
  -- Balance after this return period ('YYYY-MM'); an opening balance uses the period before the
  -- first one tracked.
  as_of_period TEXT        NOT NULL CHECK (as_of_period ~ '^[0-9]{4}-[0-9]{2}$'),
  igst         BIGINT      NOT NULL,
  cgst         BIGINT      NOT NULL,
  sgst         BIGINT      NOT NULL,
  cess         BIGINT      NOT NULL,
  source       TEXT        NOT NULL CHECK (source IN ('declared', 'portal_file')),
  note         TEXT,
  created_by   UUID        NOT NULL REFERENCES users (id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq   BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);
CREATE INDEX gst_statement_balances_idx
  ON gst_statement_balances (tenant_id, gstin, statement, as_of_period DESC, created_at DESC);
SELECT app.setup_tenant_table('gst_statement_balances');
SELECT app.restrict_table('gst_statement_balances', ARRAY['UPDATE', 'DELETE']);

CREATE TABLE rcm_self_invoices (
  id                UUID        PRIMARY KEY,
  tenant_id         UUID        NOT NULL REFERENCES tenants (id),
  gstin             TEXT        NOT NULL,
  purchase_bill_id  UUID        NOT NULL,
  fy_start_year     INTEGER     NOT NULL,
  sequence_no       INTEGER     NOT NULL CHECK (sequence_no > 0),
  document_number   TEXT        NOT NULL CHECK (length(document_number) <= 16),
  document_date     DATE        NOT NULL,
  receipt_date      DATE        NOT NULL,
  taxable_amount    BIGINT      NOT NULL,
  igst              BIGINT      NOT NULL,
  cgst              BIGINT      NOT NULL,
  sgst              BIGINT      NOT NULL,
  cess              BIGINT      NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  created_by        UUID        NOT NULL REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq        BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purchase_bill_id),
  UNIQUE (tenant_id, gstin, fy_start_year, sequence_no),
  FOREIGN KEY (tenant_id, purchase_bill_id) REFERENCES purchase_bills (tenant_id, id),
  CHECK (document_date >= receipt_date)
);
SELECT app.setup_tenant_table('rcm_self_invoices');
SELECT app.restrict_table('rcm_self_invoices', ARRAY['DELETE']);
CREATE TRIGGER rcm_self_invoices_guard BEFORE UPDATE ON rcm_self_invoices FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update('status', 'updated_at', 'server_seq');

SELECT app.grant_runtime_privileges();
