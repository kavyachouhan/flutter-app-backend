-- 0040 — Series families, registration-scoped numbering and the offline issuance fields (A0b).
--
-- Implements docs/gst/A0A_ARCHITECTURE_FREEZE.md §5 (series types, families, number blocks,
-- device watermark, issuance authorisations) and the D33 rejection log.
--
-- Table contract:
--   document_series.series_family  derived from document_type (generated): which GST family a
--       series' numbers belong to, or non_gst. Decides registry membership and Table 13 bucket.
--   document_series.registration_id / number_blocks.registration_id
--       the outlet's registration, kept in step by trigger.
--   number_blocks.lock_epoch_at_lease  the registration's lock epoch when the block was leased.
--   devices.last_synced_device_seq / last_delivered_lock_epoch
--       the server-observed watermark D33 relies on (never a device-supplied clock).
--   issuance_authorisations  short-lived online permission to issue one back-dated document;
--       granted only while the period is open; used at most once.
--   document_issue_rejections  append-only log of issue attempts refused at sync
--       (rejected_after_lock_known). The attempt was never a document; its number is recorded
--       in gst_document_numbers as rejected_before_issue, never as a cancellation.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- document_series: new types, family, registration
-- ===========================================================================

-- destructive-ok: DROP_CONSTRAINT — replaced on the next line by the same list plus the A4/A7 types
ALTER TABLE document_series DROP CONSTRAINT document_series_document_type_check;
ALTER TABLE document_series ADD CONSTRAINT document_series_document_type_check CHECK (document_type IN (
  'invoice', 'credit_note', 'debit_note', 'payment_receipt', 'refund_voucher',
  'purchase_order', 'purchase_bill', 'estimate', 'sales_order', 'delivery_challan',
  'stock_transfer', 'expense', 'proforma_invoice',
  'bill_of_supply', 'sales_debit_note', 'financial_credit_note', 'rcm_self_invoice', 'rcm_payment_voucher'));

-- 'debit_note' is the purchase return (stays non-GST for the outward registry);
-- payment_receipt / refund_voucher are payment records, not s.31(3)(d)/(e) vouchers (open item V1).
ALTER TABLE document_series ADD COLUMN series_family TEXT GENERATED ALWAYS AS (
  CASE document_type
    WHEN 'invoice'             THEN 'outward_invoice'
    WHEN 'bill_of_supply'      THEN 'bill_of_supply'
    WHEN 'credit_note'         THEN 'credit_note'
    WHEN 'sales_debit_note'    THEN 'debit_note_outward'
    WHEN 'delivery_challan'    THEN 'delivery_challan'
    WHEN 'rcm_self_invoice'    THEN 'rcm_self_invoice'
    WHEN 'rcm_payment_voucher' THEN 'payment_voucher'
    ELSE 'non_gst'
  END) STORED;

ALTER TABLE document_series ADD COLUMN registration_id UUID;
ALTER TABLE document_series ADD CONSTRAINT document_series_registration_fk
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id);
UPDATE document_series s SET registration_id = o.registration_id
  FROM outlets o WHERE o.id = s.outlet_id AND o.registration_id IS NOT NULL;

ALTER TABLE number_blocks ADD COLUMN registration_id UUID;
ALTER TABLE number_blocks ADD COLUMN lock_epoch_at_lease BIGINT NOT NULL DEFAULT 0 CHECK (lock_epoch_at_lease >= 0);
ALTER TABLE number_blocks ADD CONSTRAINT number_blocks_registration_fk
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id);
UPDATE number_blocks b SET registration_id = s.registration_id
  FROM document_series s WHERE s.id = b.series_id AND s.registration_id IS NOT NULL;

-- A series and its blocks follow their outlet's registration.
CREATE FUNCTION app.series_registration_defaults() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'document_series' THEN
    SELECT o.registration_id INTO NEW.registration_id FROM outlets o WHERE o.id = NEW.outlet_id;
  ELSE
    SELECT s.registration_id INTO NEW.registration_id FROM document_series s WHERE s.id = NEW.series_id;
    SELECT r.lock_epoch INTO NEW.lock_epoch_at_lease FROM gst_registrations r WHERE r.id = NEW.registration_id;
    NEW.lock_epoch_at_lease := COALESCE(NEW.lock_epoch_at_lease, 0);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_series_a_registration BEFORE INSERT OR UPDATE OF outlet_id ON document_series
  FOR EACH ROW EXECUTE FUNCTION app.series_registration_defaults();
CREATE TRIGGER number_blocks_a_registration BEFORE INSERT ON number_blocks
  FOR EACH ROW EXECUTE FUNCTION app.series_registration_defaults();

CREATE FUNCTION app.outlet_registration_to_series() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE document_series SET registration_id = NEW.registration_id
   WHERE outlet_id = NEW.id AND registration_id IS DISTINCT FROM NEW.registration_id;
  RETURN NULL;
END $$;

CREATE TRIGGER outlets_registration_to_series AFTER UPDATE OF registration_id ON outlets
  FOR EACH ROW EXECUTE FUNCTION app.outlet_registration_to_series();

-- ===========================================================================
-- Devices: the server-observed sync watermark (D33)
-- ===========================================================================

ALTER TABLE devices ADD COLUMN last_synced_device_seq BIGINT CHECK (last_synced_device_seq >= 0);
-- { registrationId: lock_epoch } as last delivered to this device.
ALTER TABLE devices ADD COLUMN last_delivered_lock_epoch JSONB NOT NULL DEFAULT '{}'::JSONB
  CHECK (jsonb_typeof(last_delivered_lock_epoch) = 'object');

-- ===========================================================================
-- issuance_authorisations (online back-dating, D33 rule 1)
-- ===========================================================================

-- no-tenant-setup: issuance_authorisations — requested and used online; never part of the change stream
CREATE TABLE issuance_authorisations (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants (id),
  registration_id     UUID        NOT NULL,
  series_id           UUID        NOT NULL,
  device_id           UUID        NOT NULL,
  document_date       DATE        NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  used_by_document_id UUID,
  used_at             TIMESTAMPTZ,
  created_by          UUID        NOT NULL REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK ((used_by_document_id IS NULL) = (used_at IS NULL))
);
CREATE INDEX issuance_authorisations_device_idx ON issuance_authorisations (tenant_id, device_id, expires_at);
ALTER TABLE issuance_authorisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuance_authorisations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON issuance_authorisations
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
SELECT app.restrict_table('issuance_authorisations', ARRAY['DELETE']);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes', 'purchase_bills', 'debit_notes'] LOOP
    EXECUTE format('ALTER TABLE %1$I ADD CONSTRAINT %1$s_issuance_authorisation_fk
                      FOREIGN KEY (tenant_id, issuance_authorisation_id) REFERENCES issuance_authorisations (tenant_id, id)', t);
    EXECUTE format('ALTER TABLE %1$I ADD CONSTRAINT %1$s_number_block_fk
                      FOREIGN KEY (tenant_id, number_block_id) REFERENCES number_blocks (tenant_id, id)', t);
  END LOOP;
END $$;

-- ===========================================================================
-- document_issue_rejections (D33: refused attempts are audited, never dropped)
-- ===========================================================================

-- no-tenant-setup: document_issue_rejections — server-side audit of refused attempts; never synced
CREATE TABLE document_issue_rejections (
  id                      UUID        PRIMARY KEY,
  tenant_id               UUID        NOT NULL REFERENCES tenants (id),
  registration_id         UUID,
  device_id               UUID,
  series_id               UUID,
  sequence_no             BIGINT,
  document_table          TEXT        NOT NULL,
  document_number         TEXT        NOT NULL,
  attempted_document_date DATE        NOT NULL,
  classification          TEXT        NOT NULL CHECK (classification IN ('rejected_after_lock_known', 'quarantined')),
  reason                  TEXT        NOT NULL,
  payload                 JSONB       NOT NULL,
  received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES document_series (tenant_id, id)
);
CREATE INDEX document_issue_rejections_recent_idx ON document_issue_rejections (tenant_id, received_at DESC);
ALTER TABLE document_issue_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_issue_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_issue_rejections
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
SELECT app.restrict_table('document_issue_rejections', ARRAY['UPDATE', 'DELETE']);

SELECT app.grant_runtime_privileges();
