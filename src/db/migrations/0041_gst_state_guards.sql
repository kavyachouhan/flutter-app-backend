-- 0041 — GSTIN / state rules the A0b foundations rely on (freeze §2, §3; D7).
--
--   customers / suppliers  a GSTIN with no state gets the state from its prefix, so an old caller
--                          that sends only a GSTIN passes the checksum + prefix CHECK from 0038.
--   tenants / outlets      the GSTIN a tenant or outlet bills under must start with its state.
--                          Named so src/db/tx.ts can report it as a validation failure.
--   app.sync_tenant_registrations  dates a new registration from the recorded effective date, else
--                          the start of GST, never today.
--   app.gst_document_defaults  names its refusals.
--
-- Two new functions, four triggers and two replaced functions. No row is rewritten here.

SET LOCAL search_path = public, extensions;

CREATE FUNCTION app.party_state_from_gstin() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.gstin IS NOT NULL AND NEW.state_code IS NULL THEN
    NEW.state_code := left(NEW.gstin, 2);
  END IF;
  RETURN NEW;
END $$;

-- "a_0" sorts before the "a_gst_treatment" trigger; BEFORE triggers fire in name order.
CREATE TRIGGER customers_a_0_state_from_gstin BEFORE INSERT OR UPDATE OF gstin, state_code ON customers
  FOR EACH ROW EXECUTE FUNCTION app.party_state_from_gstin();
CREATE TRIGGER suppliers_a_0_state_from_gstin BEFORE INSERT OR UPDATE OF gstin, state_code ON suppliers
  FOR EACH ROW EXECUTE FUNCTION app.party_state_from_gstin();

CREATE FUNCTION app.guard_gstin_state() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  bills_under TEXT;
  state       TEXT;
BEGIN
  IF TG_TABLE_NAME = 'tenants' THEN
    bills_under := NEW.gstin;
    state := NEW.state_code;
  ELSE
    SELECT COALESCE(NEW.gstin, t.gstin), COALESCE(NEW.state_code, t.state_code)
      INTO bills_under, state FROM tenants t WHERE t.id = NEW.tenant_id;
  END IF;
  IF bills_under IS NOT NULL AND left(bills_under, 2) IS DISTINCT FROM state THEN
    RAISE EXCEPTION 'GSTIN % does not belong to state %', bills_under, state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gstin_state_prefix';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenants_a_gstin_state BEFORE INSERT OR UPDATE OF gstin, state_code ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.guard_gstin_state();
CREATE TRIGGER outlets_a_gstin_state BEFORE INSERT OR UPDATE OF gstin, state_code ON outlets
  FOR EACH ROW EXECUTE FUNCTION app.guard_gstin_state();

-- A registration with no recorded start date is treated as in force from the start of GST, as the
-- 0037 backfill and the preflight do. Dating it from today would refuse a back-dated bill.
CREATE OR REPLACE FUNCTION app.sync_tenant_registrations(p_tenant UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  t           tenants%ROWTYPE;
  g           RECORD;
  reg         gst_registrations%ROWTYPE;
  prof        gst_registration_profiles%ROWTYPE;
  want_scheme TEXT;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so a caller inside a tenant context may only touch its own.
  IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id() <> p_tenant THEN
    RAISE EXCEPTION 'cannot sync registrations of another tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM tenants WHERE id = p_tenant;
  IF NOT FOUND THEN RETURN; END IF;
  want_scheme := CASE WHEN t.is_composition THEN 'composition' ELSE 'regular' END;

  -- Every GSTIN the tenant bills under today: each live outlet's own, else the tenant's.
  FOR g IN
    SELECT DISTINCT gstin FROM (
      SELECT COALESCE(o.gstin, t.gstin) AS gstin FROM outlets o
       WHERE o.tenant_id = p_tenant AND o.deleted_at IS NULL
      UNION SELECT t.gstin) x
     WHERE gstin IS NOT NULL AND t.is_gst_registered
  LOOP
    SELECT * INTO reg FROM gst_registrations WHERE tenant_id = p_tenant AND gstin = g.gstin AND deleted_at IS NULL;
    IF NOT FOUND THEN
      INSERT INTO gst_registrations (id, tenant_id, gstin, state_code, legal_name, trade_name, effective_from)
      VALUES (gen_random_uuid(), p_tenant, g.gstin, left(g.gstin, 2), t.legal_name, t.name,
              CASE WHEN g.gstin = t.gstin THEN COALESCE(t.registration_effective_from, DATE '2017-07-01')
                   ELSE DATE '2017-07-01' END)
      RETURNING * INTO reg;
    ELSE
      UPDATE gst_registrations
         SET legal_name = t.legal_name, trade_name = t.name, effective_to = NULL
       WHERE id = reg.id
         AND (legal_name, trade_name, effective_to) IS DISTINCT FROM (t.legal_name, t.name, NULL::DATE);
    END IF;

    -- The profile in force today must match the tenant's scheme and filing frequency.
    SELECT * INTO prof FROM gst_registration_profiles
     WHERE registration_id = reg.id AND effective_from <= current_date
       AND (effective_to IS NULL OR effective_to > current_date);
    IF NOT FOUND THEN
      INSERT INTO gst_registration_profiles (id, tenant_id, registration_id, effective_from, taxpayer_scheme,
                                             composition_category, composition_rate_percent, filing_frequency)
      VALUES (gen_random_uuid(), p_tenant, reg.id, LEAST(reg.effective_from, current_date), want_scheme,
              CASE WHEN t.is_composition THEN t.composition_category END,
              CASE WHEN t.is_composition THEN t.composition_rate_percent END, t.filing_frequency);
    ELSIF (prof.taxpayer_scheme, prof.composition_category, prof.composition_rate_percent, prof.filing_frequency)
          IS DISTINCT FROM (want_scheme, CASE WHEN t.is_composition THEN t.composition_category END,
                            CASE WHEN t.is_composition THEN t.composition_rate_percent END, t.filing_frequency) THEN
      IF prof.effective_from = current_date THEN
        UPDATE gst_registration_profiles
           SET taxpayer_scheme = want_scheme,
               composition_category = CASE WHEN t.is_composition THEN t.composition_category END,
               composition_rate_percent = CASE WHEN t.is_composition THEN t.composition_rate_percent END,
               filing_frequency = t.filing_frequency
         WHERE id = prof.id;
      ELSE
        UPDATE gst_registration_profiles SET effective_to = current_date WHERE id = prof.id;
        INSERT INTO gst_registration_profiles (id, tenant_id, registration_id, effective_from, effective_to,
                                               taxpayer_scheme, composition_category, composition_rate_percent,
                                               filing_frequency)
        VALUES (gen_random_uuid(), p_tenant, reg.id, current_date, prof.effective_to, want_scheme,
                CASE WHEN t.is_composition THEN t.composition_category END,
                CASE WHEN t.is_composition THEN t.composition_rate_percent END, t.filing_frequency);
      END IF;
    END IF;
  END LOOP;

  -- A GSTIN the tenant no longer bills under stops being in force today.
  UPDATE gst_registrations r
     SET effective_to = GREATEST(current_date, r.effective_from + 1)
   WHERE r.tenant_id = p_tenant AND r.deleted_at IS NULL AND r.effective_to IS NULL
     -- NULLs are filtered out: `x IN (…, NULL)` is NULL, which would keep a stale registration open.
     AND NOT (t.is_gst_registered AND r.gstin IN (
           SELECT s.gstin FROM (
             SELECT COALESCE(o.gstin, t.gstin) AS gstin FROM outlets o
              WHERE o.tenant_id = p_tenant AND o.deleted_at IS NULL
             UNION SELECT t.gstin) s
            WHERE s.gstin IS NOT NULL));

  UPDATE outlets o
     SET registration_id = r.id
    FROM (SELECT o2.id AS outlet_id,
                 (SELECT r2.id FROM gst_registrations r2
                   WHERE r2.tenant_id = p_tenant AND r2.deleted_at IS NULL AND r2.effective_to IS NULL
                     AND t.is_gst_registered AND r2.gstin = COALESCE(o2.gstin, t.gstin)) AS id
            FROM outlets o2 WHERE o2.tenant_id = p_tenant) r
   WHERE o.id = r.outlet_id AND o.registration_id IS DISTINCT FROM r.id;
END $$;

-- The two refusals a caller can reach now carry a constraint name, so src/db/tx.ts reports them
-- as validation failures rather than internal errors. Otherwise unchanged from 0039.
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

SELECT app.grant_runtime_privileges();
