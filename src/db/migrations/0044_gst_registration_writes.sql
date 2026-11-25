-- 0044 — Registrations become the source of GST facts, and non-tax documents freeze their parties.
--
-- Freeze §9a, "when the direction flips". Until now the tenant and outlet APIs wrote the old GST
-- columns and triggers derived the registration tables. Now the API calls the functions below,
-- which write the registration tables and then mirror the old columns for app versions that still
-- read them. The contract migration drops those columns once none do.
--
-- Function contract:
--   app.set_tenant_gst       the business's own GST facts: its principal registration and profile
--   app.set_outlet_gstin     an outlet's own GSTIN, or its use of the principal one
--   app.apply_gst_registration, app.close_unused_registrations   their shared steps
--
-- gst_registrations.is_principal marks the GSTIN of the business itself (tenants.gstin).
--
-- estimates, sales_orders, proforma_invoices, delivery_challans gain registration_id and the party
-- snapshots (freeze §4). They are not tax documents and stay editable, so these are refreshed on
-- each edit rather than being immutable.

SET LOCAL search_path = public, extensions;

ALTER TABLE gst_registrations ADD COLUMN is_principal BOOLEAN NOT NULL DEFAULT false;
UPDATE gst_registrations r SET is_principal = true
  FROM tenants t
 WHERE t.id = r.tenant_id AND t.gstin = r.gstin AND r.deleted_at IS NULL AND r.effective_to IS NULL;
CREATE UNIQUE INDEX gst_registrations_one_principal ON gst_registrations (tenant_id)
  WHERE is_principal AND deleted_at IS NULL;

-- destructive-ok: DROP_TRIGGER — the API now writes registrations directly; replaced by the functions below
DROP TRIGGER tenants_sync_registrations ON tenants;
-- destructive-ok: DROP_TRIGGER — as above
DROP TRIGGER outlets_sync_registrations ON outlets;
-- destructive-ok: DROP_FUNCTION — the trigger function has no remaining trigger
DROP FUNCTION app.sync_tenant_registrations_trigger();
-- destructive-ok: DROP_FUNCTION — its steps moved into the functions below
DROP FUNCTION app.sync_tenant_registrations(UUID);

-- One registration, created or reopened, with the given scheme and frequency in force today. A
-- change closes the profile in force and opens a new one, so past documents keep their scheme.
CREATE FUNCTION app.apply_gst_registration(
  p_tenant UUID, p_gstin TEXT, p_from DATE, p_scheme TEXT, p_category TEXT, p_rate NUMERIC,
  p_frequency TEXT, p_trade_name TEXT, p_legal_name TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  reg  gst_registrations%ROWTYPE;
  prof gst_registration_profiles%ROWTYPE;
  cat  TEXT    := CASE WHEN p_scheme = 'composition' THEN p_category END;
  rate NUMERIC := CASE WHEN p_scheme = 'composition' THEN p_rate END;
BEGIN
  IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id() <> p_tenant THEN
    RAISE EXCEPTION 'cannot change registrations of another tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO reg FROM gst_registrations WHERE tenant_id = p_tenant AND gstin = p_gstin AND deleted_at IS NULL;
  IF NOT FOUND THEN
    INSERT INTO gst_registrations (id, tenant_id, gstin, state_code, legal_name, trade_name, effective_from)
    VALUES (gen_random_uuid(), p_tenant, p_gstin, left(p_gstin, 2), p_legal_name, p_trade_name, p_from)
    RETURNING * INTO reg;
  ELSE
    UPDATE gst_registrations
       SET legal_name = p_legal_name, trade_name = p_trade_name, effective_to = NULL
     WHERE id = reg.id
       AND (legal_name, trade_name, effective_to) IS DISTINCT FROM (p_legal_name, p_trade_name, NULL::DATE);
  END IF;

  SELECT * INTO prof FROM gst_registration_profiles
   WHERE registration_id = reg.id AND effective_from <= current_date
     AND (effective_to IS NULL OR effective_to > current_date);
  IF NOT FOUND THEN
    INSERT INTO gst_registration_profiles (id, tenant_id, registration_id, effective_from, taxpayer_scheme,
                                           composition_category, composition_rate_percent, filing_frequency)
    VALUES (gen_random_uuid(), p_tenant, reg.id, LEAST(reg.effective_from, current_date), p_scheme, cat, rate, p_frequency);
  ELSIF (prof.taxpayer_scheme, prof.composition_category, prof.composition_rate_percent, prof.filing_frequency)
        IS DISTINCT FROM (p_scheme, cat, rate, p_frequency) THEN
    IF prof.effective_from = current_date THEN
      UPDATE gst_registration_profiles
         SET taxpayer_scheme = p_scheme, composition_category = cat,
             composition_rate_percent = rate, filing_frequency = p_frequency
       WHERE id = prof.id;
    ELSE
      UPDATE gst_registration_profiles SET effective_to = current_date WHERE id = prof.id;
      INSERT INTO gst_registration_profiles (id, tenant_id, registration_id, effective_from, effective_to,
                                             taxpayer_scheme, composition_category, composition_rate_percent,
                                             filing_frequency)
      VALUES (gen_random_uuid(), p_tenant, reg.id, current_date, prof.effective_to, p_scheme, cat, rate, p_frequency);
    END IF;
  END IF;
  RETURN reg.id;
END $$;

-- A GSTIN no live outlet uses, and which is not the principal one, stops being in force today.
CREATE FUNCTION app.close_unused_registrations(p_tenant UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id() <> p_tenant THEN
    RAISE EXCEPTION 'cannot change registrations of another tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE gst_registrations r
     SET effective_to = GREATEST(current_date, r.effective_from + 1)
   WHERE r.tenant_id = p_tenant AND r.deleted_at IS NULL AND r.effective_to IS NULL
     AND NOT r.is_principal
     AND NOT EXISTS (SELECT 1 FROM outlets o WHERE o.registration_id = r.id AND o.deleted_at IS NULL);
END $$;

CREATE FUNCTION app.set_tenant_gst(
  p_tenant UUID, p_registered BOOLEAN, p_gstin TEXT, p_state TEXT, p_composition BOOLEAN, p_category TEXT,
  p_rate NUMERIC, p_frequency TEXT, p_effective_from DATE, p_trade_name TEXT, p_legal_name TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  scheme    TEXT := CASE WHEN p_composition THEN 'composition' ELSE 'regular' END;
  principal UUID;
  o         RECORD;
BEGIN
  IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id() <> p_tenant THEN
    RAISE EXCEPTION 'cannot change registrations of another tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE gst_registrations SET is_principal = false
   WHERE tenant_id = p_tenant AND is_principal AND (NOT p_registered OR gstin IS DISTINCT FROM p_gstin);

  IF p_registered THEN
    principal := app.apply_gst_registration(p_tenant, p_gstin, COALESCE(p_effective_from, DATE '2017-07-01'),
                                            scheme, p_category, p_rate, p_frequency, p_trade_name, p_legal_name);
    UPDATE gst_registrations SET is_principal = true WHERE id = principal AND NOT is_principal;

    -- All of a business's GSTINs share its scheme and frequency, as they always have here.
    FOR o IN SELECT id, gstin FROM outlets WHERE tenant_id = p_tenant AND deleted_at IS NULL LOOP
      UPDATE outlets
         SET registration_id = CASE WHEN o.gstin IS NULL THEN principal
                                    ELSE app.apply_gst_registration(p_tenant, o.gstin, DATE '2017-07-01', scheme,
                                           p_category, p_rate, p_frequency, p_trade_name, p_legal_name) END
       WHERE id = o.id;
    END LOOP;
    PERFORM app.close_unused_registrations(p_tenant);
  ELSE
    UPDATE outlets SET registration_id = NULL WHERE tenant_id = p_tenant AND registration_id IS NOT NULL;
    UPDATE gst_registrations
       SET effective_to = GREATEST(current_date, effective_from + 1)
     WHERE tenant_id = p_tenant AND deleted_at IS NULL AND effective_to IS NULL;
  END IF;

  -- The mirror, for app versions that still read these columns.
  UPDATE tenants
     SET is_gst_registered = p_registered,
         gstin = CASE WHEN p_registered THEN p_gstin END,
         state_code = p_state,
         is_composition = p_composition,
         composition_category = p_category,
         composition_rate_percent = p_rate,
         filing_frequency = p_frequency,
         registration_effective_from = p_effective_from
   WHERE id = p_tenant;
END $$;

CREATE FUNCTION app.set_outlet_gstin(p_outlet UUID, p_gstin TEXT, p_state TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  o      outlets%ROWTYPE;
  t      tenants%ROWTYPE;
  target UUID;
BEGIN
  SELECT * INTO o FROM outlets WHERE id = p_outlet;
  IF NOT FOUND THEN RETURN; END IF;
  IF app.current_tenant_id() IS NOT NULL AND app.current_tenant_id() <> o.tenant_id THEN
    RAISE EXCEPTION 'cannot change registrations of another tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM tenants WHERE id = o.tenant_id;

  IF t.is_gst_registered THEN
    IF p_gstin IS NULL THEN
      SELECT id INTO target FROM gst_registrations
       WHERE tenant_id = o.tenant_id AND is_principal AND deleted_at IS NULL;
    ELSE
      target := app.apply_gst_registration(o.tenant_id, p_gstin, DATE '2017-07-01',
                  CASE WHEN t.is_composition THEN 'composition' ELSE 'regular' END,
                  t.composition_category, t.composition_rate_percent, t.filing_frequency, t.name, t.legal_name);
    END IF;
  END IF;

  UPDATE outlets SET registration_id = target, gstin = p_gstin, state_code = p_state WHERE id = p_outlet;
  PERFORM app.close_unused_registrations(o.tenant_id);
END $$;

-- ===========================================================================
-- Party snapshots on the documents that are not tax documents
-- ===========================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['estimates', 'sales_orders', 'proforma_invoices', 'delivery_challans'] LOOP
    EXECUTE format($f$
      ALTER TABLE %1$I
        ADD COLUMN registration_id        UUID,
        ADD COLUMN seller_snapshot        JSONB,
        ADD COLUMN buyer_snapshot         JSONB,
        ADD COLUMN ship_to_snapshot       JSONB,
        ADD COLUMN dispatch_from_snapshot JSONB,
        ADD CONSTRAINT %1$s_registration_fk FOREIGN KEY (tenant_id, registration_id)
            REFERENCES gst_registrations (tenant_id, id)
    $f$, t);
  END LOOP;
END $$;

SELECT app.grant_runtime_privileges();
