-- 0042 — Trigger functions shared by tables with different columns (A0b).
--
-- PL/pgSQL parses a whole expression before evaluating any of it, so `TG_TABLE_NAME = 'x' AND
-- NEW.only_on_x` fails on every other table even though the first test is false. A statement
-- inside an IF that did not run is never parsed, so each column is now touched only inside a
-- branch for the tables that have it. Behaviour is otherwise what 0037, 0038, 0039 and 0041 say.
--
-- Replaces four functions; no table, row or trigger changes.

SET LOCAL search_path = public, extensions;

CREATE OR REPLACE FUNCTION app.sync_tenant_registrations_trigger() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'tenants' THEN
    PERFORM app.sync_tenant_registrations(NEW.id);
  ELSE
    PERFORM app.sync_tenant_registrations(NEW.tenant_id);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.derive_party_gst_treatment() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  gstin_kinds CONSTANT TEXT[] := ARRAY['registered_regular', 'registered_composition', 'sez_unit', 'sez_developer'];
  explicit BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    explicit := NEW.gst_treatment IS DISTINCT FROM OLD.gst_treatment;
  END IF;

  IF TG_TABLE_NAME = 'suppliers' AND NOT explicit THEN
    IF NEW.gst_treatment IS NULL THEN
      -- Old callers describe a supplier by registration_type.
      NEW.gst_treatment := CASE WHEN NEW.gstin IS NULL THEN 'unregistered'
                                WHEN NEW.registration_type = 'composition' THEN 'registered_composition'
                                ELSE 'registered_regular' END;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.registration_type IS DISTINCT FROM OLD.registration_type AND NEW.gstin IS NOT NULL THEN
        NEW.gst_treatment := CASE WHEN NEW.registration_type = 'composition' THEN 'registered_composition'
                                  ELSE 'registered_regular' END;
      END IF;
    END IF;
  END IF;

  IF NEW.gst_treatment IS NULL THEN
    NEW.gst_treatment := CASE WHEN NEW.gstin IS NOT NULL THEN 'registered_regular'
                              WHEN NEW.uin IS NOT NULL THEN 'uin_holder'
                              WHEN NEW.country_code IS DISTINCT FROM 'IN' THEN 'overseas'
                              ELSE CASE WHEN TG_TABLE_NAME = 'suppliers' THEN 'unregistered' ELSE 'consumer' END END;
  ELSIF NOT explicit AND TG_OP = 'UPDATE' THEN
    IF NEW.gstin IS DISTINCT FROM OLD.gstin THEN
      -- A GSTIN added or removed by an old caller moves the treatment with it.
      IF NEW.gstin IS NOT NULL AND NOT (NEW.gst_treatment = ANY (gstin_kinds)) THEN
        NEW.gst_treatment := 'registered_regular';
      ELSIF NEW.gstin IS NULL AND NEW.gst_treatment = ANY (gstin_kinds) THEN
        NEW.gst_treatment := CASE WHEN TG_TABLE_NAME = 'suppliers' THEN 'unregistered' ELSE 'consumer' END;
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'suppliers' THEN
    -- Keep the deprecated column equal for readers that still use it.
    NEW.registration_type := CASE NEW.gst_treatment
                               WHEN 'registered_composition' THEN 'composition'
                               WHEN 'registered_regular' THEN 'regular'
                               WHEN 'sez_unit' THEN 'regular'
                               WHEN 'sez_developer' THEN 'regular'
                               ELSE 'unregistered' END;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.gst_document_defaults() RETURNS TRIGGER
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
        USING ERRCODE = 'check_violation', CONSTRAINT = 'gst_document_registration';
    END IF;
  ELSIF NEW.registration_id IS NOT NULL THEN
    SELECT * INTO reg FROM gst_registrations WHERE id = NEW.registration_id;
  END IF;

  IF outward THEN
    IF NEW.registration_id IS NOT NULL AND NEW.supplier_gstin IS DISTINCT FROM reg.gstin THEN
      RAISE EXCEPTION 'seller GSTIN % on % does not match its registration %', NEW.supplier_gstin, TG_TABLE_NAME, reg.gstin
        USING ERRCODE = 'check_violation', CONSTRAINT = 'gst_document_seller_gstin';
    END IF;
    IF NEW.buyer_gst_treatment IS NULL THEN
      SELECT c.gst_treatment INTO NEW.buyer_gst_treatment FROM customers c WHERE c.id = NEW.customer_id;
      NEW.buyer_gst_treatment := COALESCE(NEW.buyer_gst_treatment,
        CASE WHEN NEW.customer_gstin IS NOT NULL THEN 'registered_regular' ELSE 'consumer' END);
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'invoices' THEN
    IF NEW.document_type IS NULL AND NEW.tax_mode <> 'non_gst' THEN
      NEW.document_type := CASE NEW.tax_mode WHEN 'gst' THEN 'tax_invoice' ELSE 'bill_of_supply' END;
    END IF;
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
  ELSIF TG_TABLE_NAME = 'debit_notes' THEN
    IF NEW.original_document_date IS NULL THEN
      SELECT b.document_date INTO NEW.original_document_date FROM purchase_bills b WHERE b.id = NEW.purchase_bill_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

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

SELECT app.grant_runtime_privileges();
