-- 0039 — GST columns on issued documents, legacy labelling, lifecycle and the number registry (A0b).
--
-- Implements docs/gst/A0A_ARCHITECTURE_FREEZE.md §4 and §5 (registry) under the §9a amendment.
-- Covers invoices and credit_notes (outward) and purchase_bills and debit_notes (inward).
-- sales_debit_notes, financial_credit_notes and rcm_self_invoices are created by A4/A7 (§9a).
--
-- Table contract (per document):
--   registration_id / registration_resolution
--       resolved            registration_id set: issuing (outward) or receiving (inward)
--       non_gst             provably non-GST: tax_mode non_gst and no registration in force
--       legacy_unresolved   migrated row whose registration could not be determined:
--                           quarantined, never confused with non_gst; only migrated rows
--   supply_scenario, pos_*, snapshots, tax_point_*, rule_set_version
--       set by A1/A2/A3; nullable for new rows until the contract migration. Migrated rows are
--       labelled legacy_unclassified / 'legacy' and are never recomputed.
--   status × irn_state  outward documents only; permitted pairs and transitions enforced here.
--   gst_document_numbers  one row per number an outward GST document consumed; unique per
--       (registration, FY, number) across every series. Migrated rows are not entered.
--
-- Migrated rows: labelled only. No amount, tax, total or summary is touched. The guard
-- triggers that keep issued documents immutable are suspended for the labelling UPDATEs
-- inside this transaction and re-enabled before it ends.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Columns
-- ===========================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes', 'purchase_bills', 'debit_notes'] LOOP
    EXECUTE format($f$
      ALTER TABLE %1$I
        ADD COLUMN registration_id              UUID,
        ADD COLUMN registration_resolution      TEXT,
        ADD COLUMN supply_scenario              TEXT,
        ADD COLUMN pos_provision                TEXT,
        ADD COLUMN pos_override                 JSONB,
        ADD COLUMN sez_authorised_operations    BOOLEAN,
        ADD COLUMN lut_reference                TEXT,
        ADD COLUMN tax_payable_by               TEXT,
        ADD COLUMN seller_snapshot              JSONB,
        ADD COLUMN buyer_snapshot               JSONB,
        ADD COLUMN ship_to_snapshot             JSONB,
        ADD COLUMN dispatch_from_snapshot       JSONB,
        ADD COLUMN tax_point_date               DATE,
        ADD COLUMN tax_point_facts              JSONB,
        ADD COLUMN tax_point_provision          TEXT,
        ADD COLUMN tax_point_override           JSONB,
        ADD COLUMN rule_set_version             TEXT REFERENCES gst_rule_sets (version),
        ADD COLUMN irn_state                    TEXT NOT NULL DEFAULT 'not_required',
        ADD COLUMN device_seq                   BIGINT,
        ADD COLUMN clock_offset_ms_at_last_sync INTEGER,
        ADD COLUMN lock_epoch_known             BIGINT,
        ADD COLUMN number_block_id              UUID,
        ADD COLUMN issuance_authorisation_id    UUID,
        -- Existing rows were created before D33 classification existed.
        ADD COLUMN sync_classification          TEXT NOT NULL DEFAULT 'server_created'
    $f$, t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN sync_classification SET DEFAULT %L', t, 'accepted');
  END LOOP;

  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes'] LOOP
    EXECUTE format($f$
      ALTER TABLE %1$I
        ADD COLUMN buyer_gst_treatment TEXT,
        ADD COLUMN customer_uin        TEXT,
        ADD COLUMN sales_channel       TEXT NOT NULL DEFAULT 'direct',
        ADD COLUMN eco_gstin           TEXT
    $f$, t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['invoice_lines', 'credit_note_lines', 'purchase_bill_lines', 'debit_note_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN uqc TEXT', t);
  END LOOP;
END $$;

ALTER TABLE invoices ADD COLUMN document_type TEXT;

ALTER TABLE credit_notes ADD COLUMN original_document_date        DATE;
ALTER TABLE credit_notes ADD COLUMN correction_reason             TEXT;
ALTER TABLE credit_notes ADD COLUMN recipient_itc_reversal_status TEXT;

ALTER TABLE debit_notes ADD COLUMN original_document_date DATE;

-- Recipient ITC facts (freeze §4.4a); never used as the tax point.
ALTER TABLE purchase_bills ADD COLUMN goods_received_date    DATE;
ALTER TABLE purchase_bills ADD COLUMN receipt_complete       BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE purchase_bills ADD COLUMN services_received_date DATE;
ALTER TABLE purchase_bills ADD COLUMN boe_number             TEXT;
ALTER TABLE purchase_bills ADD COLUMN boe_date               DATE;
ALTER TABLE purchase_bills ADD COLUMN boe_port_code          TEXT;

-- ===========================================================================
-- Label migrated rows (guards suspended inside this transaction only)
-- ===========================================================================

ALTER TABLE invoices       DISABLE TRIGGER invoices_guard;
ALTER TABLE credit_notes   DISABLE TRIGGER credit_notes_guard;
ALTER TABLE purchase_bills DISABLE TRIGGER purchase_bills_guard;
ALTER TABLE debit_notes    DISABLE TRIGGER debit_notes_guard;

-- Registration resolution (freeze §9). The outlet's registration is "in force" on the document date.
CREATE TEMP TABLE gst_legacy_resolution ON COMMIT DROP AS
WITH outlet_reg AS (
  SELECT o.id AS outlet_id, r.id AS reg_id, r.gstin, r.effective_from, r.effective_to
    FROM outlets o LEFT JOIN gst_registrations r ON r.id = o.registration_id
),
docs AS (
  SELECT 'invoices' AS tbl, d.id, d.tenant_id, d.outlet_id, d.document_date, d.tax_mode, d.supplier_gstin, true AS outward FROM invoices d
  UNION ALL SELECT 'credit_notes', d.id, d.tenant_id, d.outlet_id, d.document_date, d.tax_mode, d.supplier_gstin, true FROM credit_notes d
  UNION ALL SELECT 'purchase_bills', d.id, d.tenant_id, d.outlet_id, d.document_date, d.tax_mode, d.supplier_gstin, false FROM purchase_bills d
  UNION ALL SELECT 'debit_notes', d.id, d.tenant_id, d.outlet_id, d.document_date, d.tax_mode, d.supplier_gstin, false FROM debit_notes d
)
SELECT d.tbl, d.id,
       CASE
         WHEN d.outward AND d.supplier_gstin IS NOT NULL THEN snap.id
         WHEN NOT d.outward AND inforce THEN r.reg_id
       END AS reg_id,
       CASE
         WHEN d.outward AND d.supplier_gstin IS NOT NULL AND snap.id IS NOT NULL THEN 'resolved'
         WHEN d.outward AND d.supplier_gstin IS NOT NULL THEN 'legacy_unresolved'
         WHEN NOT d.outward AND inforce THEN 'resolved'
         WHEN d.tax_mode = 'non_gst' AND NOT inforce THEN 'non_gst'
         ELSE 'legacy_unresolved'
       END AS resolution
  FROM docs d
  JOIN outlet_reg r ON r.outlet_id = d.outlet_id
  CROSS JOIN LATERAL (SELECT r.reg_id IS NOT NULL AND d.document_date >= r.effective_from
                             AND (r.effective_to IS NULL OR d.document_date < r.effective_to) AS inforce) f
  -- The seller GSTIN printed on an outward document, when it is one of the same tenant's registrations.
  LEFT JOIN gst_registrations snap ON d.outward AND snap.tenant_id = d.tenant_id AND snap.gstin = d.supplier_gstin;

UPDATE invoices d
   SET registration_id = x.reg_id, registration_resolution = x.resolution,
       document_type = CASE d.tax_mode WHEN 'gst' THEN 'tax_invoice' WHEN 'composition' THEN 'bill_of_supply' END,
       buyer_gst_treatment = CASE WHEN d.customer_gstin IS NOT NULL THEN 'registered_regular' ELSE 'consumer' END,
       supply_scenario = 'legacy_unclassified', pos_provision = 'legacy',
       tax_point_date = d.document_date, tax_point_provision = 'legacy',
       tax_point_facts = jsonb_build_object('legacyDocumentDate', d.document_date),
       rule_set_version = 'legacy',
       tax_payable_by = CASE WHEN d.is_reverse_charge THEN 'recipient' ELSE 'supplier' END,
       seller_snapshot = jsonb_build_object('legacy', true, 'gstin', d.supplier_gstin,
                           'address', jsonb_build_object('stateCode', d.supplier_state_code, 'countryCode', 'IN')),
       buyer_snapshot = jsonb_build_object('legacy', true, 'name', d.customer_name, 'gstin', d.customer_gstin)
  FROM gst_legacy_resolution x
 WHERE x.tbl = 'invoices' AND x.id = d.id;

UPDATE credit_notes d
   SET registration_id = x.reg_id, registration_resolution = x.resolution,
       buyer_gst_treatment = CASE WHEN d.customer_gstin IS NOT NULL THEN 'registered_regular' ELSE 'consumer' END,
       original_document_date = (SELECT i.document_date FROM invoices i WHERE i.id = d.original_invoice_id),
       recipient_itc_reversal_status = CASE WHEN d.customer_gstin IS NOT NULL THEN 'unknown' ELSE 'not_applicable' END,
       supply_scenario = 'legacy_unclassified', pos_provision = 'legacy',
       tax_point_date = d.document_date, tax_point_provision = 'legacy',
       tax_point_facts = jsonb_build_object('legacyDocumentDate', d.document_date),
       rule_set_version = 'legacy',
       tax_payable_by = CASE WHEN d.is_reverse_charge THEN 'recipient' ELSE 'supplier' END,
       seller_snapshot = jsonb_build_object('legacy', true, 'gstin', d.supplier_gstin,
                           'address', jsonb_build_object('stateCode', d.supplier_state_code, 'countryCode', 'IN')),
       buyer_snapshot = jsonb_build_object('legacy', true, 'gstin', d.customer_gstin)
  FROM gst_legacy_resolution x
 WHERE x.tbl = 'credit_notes' AND x.id = d.id;

UPDATE purchase_bills d
   SET registration_id = x.reg_id, registration_resolution = x.resolution,
       supply_scenario = 'legacy_unclassified', pos_provision = 'legacy',
       tax_point_date = d.supplier_invoice_date, tax_point_provision = 'legacy',
       tax_point_facts = jsonb_build_object('legacyDocumentDate', d.document_date,
                                            'supplierInvoiceDate', d.supplier_invoice_date),
       rule_set_version = 'legacy',
       tax_payable_by = CASE WHEN d.is_reverse_charge THEN 'recipient' ELSE 'supplier' END,
       seller_snapshot = jsonb_build_object('legacy', true, 'gstin', d.supplier_gstin,
                           'address', jsonb_build_object('stateCode', d.supplier_state_code, 'countryCode', 'IN'))
  FROM gst_legacy_resolution x
 WHERE x.tbl = 'purchase_bills' AND x.id = d.id;

UPDATE debit_notes d
   SET registration_id = x.reg_id, registration_resolution = x.resolution,
       original_document_date = (SELECT b.document_date FROM purchase_bills b WHERE b.id = d.purchase_bill_id),
       supply_scenario = 'legacy_unclassified', pos_provision = 'legacy',
       tax_point_date = d.document_date, tax_point_provision = 'legacy',
       tax_point_facts = jsonb_build_object('legacyDocumentDate', d.document_date),
       rule_set_version = 'legacy',
       tax_payable_by = CASE WHEN d.is_reverse_charge THEN 'recipient' ELSE 'supplier' END,
       seller_snapshot = jsonb_build_object('legacy', true, 'gstin', d.supplier_gstin,
                           'address', jsonb_build_object('stateCode', d.supplier_state_code, 'countryCode', 'IN'))
  FROM gst_legacy_resolution x
 WHERE x.tbl = 'debit_notes' AND x.id = d.id;

ALTER TABLE invoices       ENABLE TRIGGER invoices_guard;
ALTER TABLE credit_notes   ENABLE TRIGGER credit_notes_guard;
ALTER TABLE purchase_bills ENABLE TRIGGER purchase_bills_guard;
ALTER TABLE debit_notes    ENABLE TRIGGER debit_notes_guard;

-- ===========================================================================
-- Constraints
-- ===========================================================================

-- Outward documents gain the provisional (pending_irn) and never-issued (withdrawn) states.
-- destructive-ok: DROP_CONSTRAINT — replaced by the wider status check on the next line
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('pending_irn', 'issued', 'void', 'withdrawn'));
-- destructive-ok: DROP_CONSTRAINT — replaced by the wider status check on the next line
ALTER TABLE credit_notes DROP CONSTRAINT credit_notes_status_check;
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_status_check
  CHECK (status IN ('pending_irn', 'issued', 'void', 'withdrawn'));

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes', 'purchase_bills', 'debit_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN registration_resolution SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tax_payable_by SET NOT NULL', t);
    EXECUTE format($f$
      ALTER TABLE %1$I
        ADD CONSTRAINT %1$s_registration_fk FOREIGN KEY (tenant_id, registration_id)
            REFERENCES gst_registrations (tenant_id, id),
        ADD CONSTRAINT %1$s_registration_resolution CHECK (
            registration_resolution IN ('resolved', 'non_gst', 'legacy_unresolved')
            AND (registration_resolution = 'resolved') = (registration_id IS NOT NULL)
            AND (registration_resolution <> 'non_gst' OR tax_mode = 'non_gst')
            AND (registration_resolution <> 'legacy_unresolved'
                 OR (supply_scenario IS NOT NULL AND supply_scenario = 'legacy_unclassified'))),
        ADD CONSTRAINT %1$s_supply_scenario CHECK (supply_scenario IN (
            'counter_sale', 'delivered', 'bill_to_ship_to', 'goods_without_movement', 'installation_at_site',
            'export_goods_with_payment', 'export_goods_under_lut', 'supply_to_sez', 'services_general',
            'supply_from_sez', 'cross_border_services', 'deemed_export', 'on_board_conveyance',
            'services_specific', 'legacy_unclassified')),
        ADD CONSTRAINT %1$s_sez_authorised CHECK (
            sez_authorised_operations IS NULL OR (supply_scenario IS NOT NULL AND supply_scenario = 'supply_to_sez')),
        ADD CONSTRAINT %1$s_pos_provision CHECK (pos_provision IN (
            'igst_10_1_a', 'igst_10_1_b', 'igst_10_1_c', 'igst_10_1_d', 'igst_11', 'igst_7_5_b',
            'igst_12_2', 'override', 'legacy')),
        ADD CONSTRAINT %1$s_tax_payable_by CHECK (
            tax_payable_by IN ('supplier', 'recipient') AND is_reverse_charge = (tax_payable_by = 'recipient')),
        ADD CONSTRAINT %1$s_tax_point_provision CHECK (tax_point_provision IN (
            'cgst_12_2', 'cgst_12_3', 'cgst_13_2', 'cgst_13_3', 'cgst_14', 'supplier_reported',
            'customs_boe', 'override', 'legacy')),
        ADD CONSTRAINT %1$s_sync_classification CHECK (sync_classification IN (
            'accepted', 'late_sync_review', 'rejected_after_lock_known', 'quarantined', 'server_created')),
        ADD CONSTRAINT %1$s_irn_state CHECK (irn_state IN (
            'not_required', 'awaiting', 'submitted_unknown', 'rejected', 'confirmed_absent',
            'registered', 'cancelled'))
    $f$, t);
  END LOOP;
END $$;

-- Inward documents are never e-invoiced by us.
ALTER TABLE purchase_bills ADD CONSTRAINT purchase_bills_irn_not_required CHECK (irn_state = 'not_required');
ALTER TABLE debit_notes ADD CONSTRAINT debit_notes_irn_not_required CHECK (irn_state = 'not_required');

-- Outward: only the (status, irn_state) pairs of freeze §4.1.
ALTER TABLE invoices ADD CONSTRAINT invoices_status_irn_pair CHECK (
     (status = 'issued'      AND irn_state IN ('not_required', 'registered'))
  OR (status = 'pending_irn' AND irn_state IN ('awaiting', 'submitted_unknown', 'rejected', 'confirmed_absent'))
  OR (status = 'void'        AND irn_state IN ('not_required', 'cancelled'))
  OR (status = 'withdrawn'   AND irn_state IN ('rejected', 'confirmed_absent')));
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_status_irn_pair CHECK (
     (status = 'issued'      AND irn_state IN ('not_required', 'registered'))
  OR (status = 'pending_irn' AND irn_state IN ('awaiting', 'submitted_unknown', 'rejected', 'confirmed_absent'))
  OR (status = 'void'        AND irn_state IN ('not_required', 'cancelled'))
  OR (status = 'withdrawn'   AND irn_state IN ('rejected', 'confirmed_absent')));

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes'] LOOP
    EXECUTE format($f$
      ALTER TABLE %1$I
        ADD CONSTRAINT %1$s_buyer_gst_treatment CHECK (buyer_gst_treatment IN (
            'registered_regular', 'registered_composition', 'unregistered', 'consumer',
            'sez_unit', 'sez_developer', 'overseas', 'uin_holder')),
        ADD CONSTRAINT %1$s_customer_uin CHECK (
            customer_uin IS NULL OR (customer_gstin IS NULL AND app.uin_valid(customer_uin))),
        ADD CONSTRAINT %1$s_sales_channel CHECK (
            sales_channel IN ('direct', 'marketplace')
            AND (sales_channel <> 'marketplace' OR (eco_gstin IS NOT NULL AND app.gstin_valid(eco_gstin)))
            AND (eco_gstin IS NULL OR sales_channel = 'marketplace'))
    $f$, t);
    -- New rows only: migrated rows keep what they were issued with.
    EXECUTE format('ALTER TABLE %1$I ADD CONSTRAINT %1$s_customer_gstin_valid
                      CHECK (customer_gstin IS NULL OR app.gstin_valid(customer_gstin)) NOT VALID', t);
  END LOOP;
END $$;

ALTER TABLE invoices ADD CONSTRAINT invoices_document_type CHECK (
  document_type IN ('tax_invoice', 'bill_of_supply', 'invoice_cum_bill_of_supply')
  AND (document_type IS NOT NULL) = (tax_mode <> 'non_gst'));
-- Rule 46A: an invoice-cum-bill of supply is issued only to an unregistered person.
ALTER TABLE invoices ADD CONSTRAINT invoices_cum_bos_buyer CHECK (
  document_type IS NULL OR document_type <> 'invoice_cum_bill_of_supply'
  OR (buyer_gst_treatment IS NOT NULL AND buyer_gst_treatment IN ('unregistered', 'consumer')));

ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_correction_reason CHECK (correction_reason IN (
  'goods_return', 'value_reduction', 'excess_tax_charged', 'post_supply_discount', 'value_increase', 'tax_undercharged'));
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_recipient_reversal CHECK (recipient_itc_reversal_status IN (
  'verified', 'pending', 'unknown', 'not_applicable'));

ALTER TABLE purchase_bills ADD CONSTRAINT purchase_bills_supplier_gstin_valid
  CHECK (supplier_gstin IS NULL OR app.gstin_valid(supplier_gstin)) NOT VALID;
ALTER TABLE debit_notes ADD CONSTRAINT debit_notes_supplier_gstin_valid
  CHECK (supplier_gstin IS NULL OR app.gstin_valid(supplier_gstin)) NOT VALID;
ALTER TABLE purchase_bills ADD CONSTRAINT purchase_bills_boe CHECK (
  (boe_number IS NULL) = (boe_date IS NULL));

-- ===========================================================================
-- Insert defaults for callers that predate these columns (freeze §9a)
-- ===========================================================================

CREATE FUNCTION app.gst_document_defaults() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  reg      gst_registrations%ROWTYPE;
  outward  BOOLEAN := TG_TABLE_NAME IN ('invoices', 'credit_notes');
BEGIN
  -- Migration-only values never appear on a new document.
  IF NEW.supply_scenario = 'legacy_unclassified' OR NEW.registration_resolution = 'legacy_unresolved'
     OR NEW.rule_set_version = 'legacy' OR NEW.pos_provision = 'legacy' OR NEW.tax_point_provision = 'legacy' THEN
    RAISE EXCEPTION 'legacy values are reserved for migrated %', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;

  -- tax_payable_by is authoritative; is_reverse_charge follows it (old callers send only the flag).
  IF NEW.tax_payable_by IS NULL THEN
    NEW.tax_payable_by := CASE WHEN NEW.is_reverse_charge THEN 'recipient' ELSE 'supplier' END;
  ELSE
    NEW.is_reverse_charge := NEW.tax_payable_by = 'recipient';
  END IF;

  -- Registration: the outlet's, when in force on the document date.
  IF NEW.registration_resolution IS NULL THEN
    SELECT r.* INTO reg FROM outlets o JOIN gst_registrations r ON r.id = o.registration_id
     WHERE o.id = NEW.outlet_id AND NEW.document_date >= r.effective_from
       AND (r.effective_to IS NULL OR NEW.document_date < r.effective_to);
    IF FOUND THEN
      NEW.registration_id := reg.id;
      NEW.registration_resolution := 'resolved';
    ELSIF NEW.tax_mode = 'non_gst' THEN
      NEW.registration_resolution := 'non_gst';
    ELSE
      RAISE EXCEPTION 'outlet % has no GST registration in force on %', NEW.outlet_id, NEW.document_date
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.registration_id IS NOT NULL THEN
    SELECT * INTO reg FROM gst_registrations WHERE id = NEW.registration_id;
  END IF;

  IF outward THEN
    IF NEW.registration_id IS NOT NULL AND NEW.supplier_gstin IS DISTINCT FROM reg.gstin THEN
      RAISE EXCEPTION 'seller GSTIN % on % does not match its registration %', NEW.supplier_gstin, TG_TABLE_NAME, reg.gstin
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.buyer_gst_treatment IS NULL THEN
      SELECT c.gst_treatment INTO NEW.buyer_gst_treatment FROM customers c WHERE c.id = NEW.customer_id;
      NEW.buyer_gst_treatment := COALESCE(NEW.buyer_gst_treatment,
        CASE WHEN NEW.customer_gstin IS NOT NULL THEN 'registered_regular' ELSE 'consumer' END);
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'invoices' AND NEW.document_type IS NULL AND NEW.tax_mode <> 'non_gst' THEN
    NEW.document_type := CASE NEW.tax_mode WHEN 'gst' THEN 'tax_invoice' ELSE 'bill_of_supply' END;
  END IF;

  IF TG_TABLE_NAME = 'credit_notes' THEN
    IF NEW.original_document_date IS NULL THEN
      SELECT i.document_date INTO NEW.original_document_date FROM invoices i WHERE i.id = NEW.original_invoice_id;
    END IF;
    IF NEW.recipient_itc_reversal_status IS NULL THEN
      NEW.recipient_itc_reversal_status := CASE
        WHEN NEW.buyer_gst_treatment IN ('registered_regular', 'registered_composition', 'sez_unit', 'sez_developer')
        THEN 'unknown' ELSE 'not_applicable' END;
    END IF;
  ELSIF TG_TABLE_NAME = 'debit_notes' AND NEW.original_document_date IS NULL THEN
    SELECT b.document_date INTO NEW.original_document_date FROM purchase_bills b WHERE b.id = NEW.purchase_bill_id;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes', 'purchase_bills', 'debit_notes'] LOOP
    -- "a_" sorts it before the server_seq trigger; BEFORE triggers fire in name order.
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION app.gst_document_defaults()',
                   t || '_a_gst_defaults', t);
  END LOOP;
END $$;

-- ===========================================================================
-- Lifecycle: permitted transitions (freeze §4.1) and legacy resolution
-- ===========================================================================

CREATE FUNCTION app.gst_document_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF (NEW.status, NEW.irn_state) IS DISTINCT FROM (OLD.status, OLD.irn_state)
     AND (OLD.status || '/' || OLD.irn_state || '>' || NEW.status || '/' || NEW.irn_state) NOT IN (
       'pending_irn/awaiting>pending_irn/submitted_unknown',
       'pending_irn/awaiting>pending_irn/rejected',
       'pending_irn/awaiting>issued/registered',
       'pending_irn/submitted_unknown>issued/registered',
       'pending_irn/submitted_unknown>pending_irn/confirmed_absent',
       'pending_irn/rejected>pending_irn/awaiting',
       'pending_irn/confirmed_absent>pending_irn/awaiting',
       'pending_irn/rejected>withdrawn/rejected',
       'pending_irn/confirmed_absent>withdrawn/confirmed_absent',
       'issued/not_required>void/not_required',
       'issued/registered>void/cancelled') THEN
    RAISE EXCEPTION '% %: % / % cannot become % / %', TG_TABLE_NAME, OLD.id,
      OLD.status, OLD.irn_state, NEW.status, NEW.irn_state USING ERRCODE = 'restrict_violation';
  END IF;
  -- Only a quarantined migrated row may have its registration resolved, once.
  IF (NEW.registration_id, NEW.registration_resolution) IS DISTINCT FROM (OLD.registration_id, OLD.registration_resolution)
     AND (OLD.registration_resolution <> 'legacy_unresolved' OR NEW.registration_resolution = 'legacy_unresolved') THEN
    RAISE EXCEPTION '% %: the registration of an issued document cannot change', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes', 'purchase_bills', 'debit_notes'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF status, irn_state, registration_id, registration_resolution
                      ON %I FOR EACH ROW EXECUTE FUNCTION app.gst_document_transition()', t || '_gst_transition', t);
  END LOOP;
END $$;

-- The immutability guards learn the newly mutable columns (state moves are checked above).
-- destructive-ok: DROP_TRIGGER — each guard is recreated immediately with a longer allow-list
DROP TRIGGER invoices_guard ON invoices;
CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at', 'updated_at', 'server_seq',
    'irn_state', 'registration_id', 'registration_resolution');
DROP TRIGGER credit_notes_guard ON credit_notes;
CREATE TRIGGER credit_notes_guard BEFORE UPDATE ON credit_notes FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at', 'updated_at', 'server_seq',
    'irn_state', 'registration_id', 'registration_resolution', 'recipient_itc_reversal_status');
DROP TRIGGER purchase_bills_guard ON purchase_bills;
CREATE TRIGGER purchase_bills_guard BEFORE UPDATE ON purchase_bills FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'updated_at', 'server_seq',
    'registration_id', 'registration_resolution', 'goods_received_date', 'receipt_complete', 'services_received_date');
DROP TRIGGER debit_notes_guard ON debit_notes;
CREATE TRIGGER debit_notes_guard BEFORE UPDATE ON debit_notes FOR EACH ROW
  EXECUTE FUNCTION app.guard_document_update(
    'status', 'void_reason', 'voided_at', 'voided_by', 'print_count', 'printed_at',
    'updated_at', 'server_seq', 'registration_id', 'registration_resolution');

-- ===========================================================================
-- Number registry (freeze §5): unique per issuing registration and FY, across every series
-- ===========================================================================

-- no-tenant-setup: gst_document_numbers — written only by document triggers, never synced
CREATE TABLE gst_document_numbers (
  tenant_id       UUID        NOT NULL REFERENCES tenants (id),
  registration_id UUID        NOT NULL,
  fy_start_year   INTEGER     NOT NULL,
  series_family   TEXT        NOT NULL CHECK (series_family IN (
                    'outward_invoice', 'bill_of_supply', 'credit_note', 'debit_note_outward',
                    'delivery_challan', 'refund_voucher', 'receipt_voucher', 'payment_voucher', 'rcm_self_invoice')),
  -- Rules 46(b), 49, 53: at most 16 characters of letters, digits, '-' and '/'.
  document_number TEXT        NOT NULL CHECK (char_length(document_number) BETWEEN 1 AND 16
                                              AND document_number ~ '^[A-Za-z0-9/-]+$'),
  number_state    TEXT        NOT NULL CHECK (number_state IN ('issued', 'cancelled', 'withdrawn', 'rejected_before_issue')),
  document_table  TEXT        NOT NULL,
  document_id     UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (registration_id, fy_start_year, document_number),
  UNIQUE (document_table, document_id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id)
);
ALTER TABLE gst_document_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_document_numbers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gst_document_numbers
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
SELECT app.restrict_table('gst_document_numbers', ARRAY['DELETE']);

CREATE FUNCTION app.gst_number_state(p_status TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT CASE p_status WHEN 'void' THEN 'cancelled' WHEN 'withdrawn' THEN 'withdrawn' ELSE 'issued' END $$;

CREATE FUNCTION app.register_gst_document_number() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.registration_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO gst_document_numbers (tenant_id, registration_id, fy_start_year, series_family, document_number,
                                      number_state, document_table, document_id)
    VALUES (NEW.tenant_id, NEW.registration_id, NEW.fy_start_year,
            CASE WHEN TG_TABLE_NAME = 'credit_notes' THEN 'credit_note'
                 WHEN NEW.document_type = 'bill_of_supply' THEN 'bill_of_supply'
                 ELSE 'outward_invoice' END,
            NEW.document_number, app.gst_number_state(NEW.status), TG_TABLE_NAME, NEW.id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE gst_document_numbers
       SET number_state = app.gst_number_state(NEW.status), updated_at = now()
     WHERE document_table = TG_TABLE_NAME AND document_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER invoices_gst_number AFTER INSERT OR UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION app.register_gst_document_number();
CREATE TRIGGER credit_notes_gst_number AFTER INSERT OR UPDATE OF status ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION app.register_gst_document_number();

COMMENT ON COLUMN invoices.is_reverse_charge IS
  'Deprecated (freeze §9a): equals tax_payable_by = ''recipient''; kept for readers until the contract migration.';

SELECT app.grant_runtime_privileges();
