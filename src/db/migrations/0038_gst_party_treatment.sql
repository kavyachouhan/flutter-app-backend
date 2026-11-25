-- 0038 — Party GST treatment, UIN, country, and customer delivery addresses (A0b).
--
-- Implements docs/gst/A0A_ARCHITECTURE_FREEZE.md §3 (D6, D7, D34) under the §9a amendment:
-- suppliers.registration_type stays and is kept equal to gst_treatment by trigger.
--
-- Table contract:
--   customers / suppliers  gain gst_treatment (what kind of party for GST), uin (UN bodies,
--                          embassies — never stored in gstin, never checksum-validated) and
--                          country_code. A GSTIN must pass app.gstin_valid and match the
--                          party's state; on existing rows that CHECK is NOT VALID and applies
--                          from each row's next write.
--   customer_addresses     delivery (ship-to) addresses of a customer; the customer row itself
--                          stays the bill-to address. Domestic rows need a state and a 6-digit
--                          pincode; overseas rows have neither state nor GSTIN.
--
-- Every conditional CHECK tests required columns with IS NOT NULL explicitly: a CHECK whose
-- expression is NULL passes.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- Columns and backfill
-- ===========================================================================

ALTER TABLE customers ADD COLUMN gst_treatment TEXT;
ALTER TABLE customers ADD COLUMN uin TEXT;
ALTER TABLE customers ADD COLUMN country_code TEXT NOT NULL DEFAULT 'IN';
ALTER TABLE suppliers ADD COLUMN gst_treatment TEXT;
ALTER TABLE suppliers ADD COLUMN uin TEXT;
ALTER TABLE suppliers ADD COLUMN country_code TEXT NOT NULL DEFAULT 'IN';

-- A GSTIN is what makes a party registered today; customers carry no finer signal.
UPDATE customers SET gst_treatment = CASE WHEN gstin IS NOT NULL THEN 'registered_regular' ELSE 'consumer' END
 WHERE gst_treatment IS NULL;
-- The GSTIN wins over registration_type: a party without one cannot be "registered".
UPDATE suppliers
   SET gst_treatment = CASE WHEN gstin IS NULL THEN 'unregistered'
                            WHEN registration_type = 'composition' THEN 'registered_composition'
                            ELSE 'registered_regular' END
 WHERE gst_treatment IS NULL;

ALTER TABLE customers ALTER COLUMN gst_treatment SET NOT NULL;
ALTER TABLE suppliers ALTER COLUMN gst_treatment SET NOT NULL;

-- ===========================================================================
-- Constraints (same rules on both party tables)
-- ===========================================================================

ALTER TABLE customers ADD CONSTRAINT customers_gst_treatment_check CHECK (gst_treatment IN (
  'registered_regular', 'registered_composition', 'unregistered', 'consumer',
  'sez_unit', 'sez_developer', 'overseas', 'uin_holder'));
ALTER TABLE suppliers ADD CONSTRAINT suppliers_gst_treatment_check CHECK (gst_treatment IN (
  'registered_regular', 'registered_composition', 'unregistered', 'consumer',
  'sez_unit', 'sez_developer', 'overseas', 'uin_holder'));

-- GSTIN-identified treatments ⇔ a GSTIN is present.
ALTER TABLE customers ADD CONSTRAINT customers_treatment_gstin CHECK (
  (gst_treatment IN ('registered_regular', 'registered_composition', 'sez_unit', 'sez_developer'))
  = (gstin IS NOT NULL));
ALTER TABLE suppliers ADD CONSTRAINT suppliers_treatment_gstin CHECK (
  (gst_treatment IN ('registered_regular', 'registered_composition', 'sez_unit', 'sez_developer'))
  = (gstin IS NOT NULL));

-- A UIN holder is identified by its UIN alone, and still has an Indian state.
ALTER TABLE customers ADD CONSTRAINT customers_treatment_uin CHECK (
  (gst_treatment = 'uin_holder') = (uin IS NOT NULL)
  AND (uin IS NULL OR (gstin IS NULL AND state_code IS NOT NULL AND app.uin_valid(uin))));
ALTER TABLE suppliers ADD CONSTRAINT suppliers_treatment_uin CHECK (
  (gst_treatment = 'uin_holder') = (uin IS NOT NULL)
  AND (uin IS NULL OR (gstin IS NULL AND state_code IS NOT NULL AND app.uin_valid(uin))));

ALTER TABLE customers ADD CONSTRAINT customers_country_code CHECK (country_code ~ '^[A-Z]{2}$');
ALTER TABLE suppliers ADD CONSTRAINT suppliers_country_code CHECK (country_code ~ '^[A-Z]{2}$');

-- Overseas half of the address rule (freeze §9a): abroad means no state, GSTIN or UIN.
ALTER TABLE customers ADD CONSTRAINT customers_overseas CHECK (
  (country_code <> 'IN') = (gst_treatment = 'overseas')
  AND (country_code = 'IN' OR (state_code IS NULL AND gstin IS NULL AND uin IS NULL)));
ALTER TABLE suppliers ADD CONSTRAINT suppliers_overseas CHECK (
  (country_code <> 'IN') = (gst_treatment = 'overseas')
  AND (country_code = 'IN' OR (state_code IS NULL AND gstin IS NULL AND uin IS NULL)));

-- Checksum + state prefix. NOT VALID: existing rows are re-validated at their next write.
ALTER TABLE customers ADD CONSTRAINT customers_gstin_valid
  CHECK (gstin IS NULL OR (app.gstin_valid(gstin) AND state_code IS NOT NULL AND state_code = left(gstin, 2))) NOT VALID;
ALTER TABLE suppliers ADD CONSTRAINT suppliers_gstin_valid
  CHECK (gstin IS NULL OR (app.gstin_valid(gstin) AND state_code IS NOT NULL AND state_code = left(gstin, 2))) NOT VALID;

-- ===========================================================================
-- Transition triggers (freeze §9a): callers that do not send gst_treatment yet
-- ===========================================================================

CREATE FUNCTION app.derive_party_gst_treatment() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  gstin_kinds CONSTANT TEXT[] := ARRAY['registered_regular', 'registered_composition', 'sez_unit', 'sez_developer'];
  explicit BOOLEAN := TG_OP = 'UPDATE' AND NEW.gst_treatment IS DISTINCT FROM OLD.gst_treatment;
BEGIN
  IF TG_TABLE_NAME = 'suppliers' AND NOT explicit AND NEW.gst_treatment IS NULL THEN
    -- Old callers describe a supplier by registration_type.
    NEW.gst_treatment := CASE WHEN NEW.gstin IS NULL THEN 'unregistered'
                              WHEN NEW.registration_type = 'composition' THEN 'registered_composition'
                              ELSE 'registered_regular' END;
  ELSIF TG_TABLE_NAME = 'suppliers' AND TG_OP = 'UPDATE' AND NOT explicit
        AND NEW.registration_type IS DISTINCT FROM OLD.registration_type AND NEW.gstin IS NOT NULL THEN
    NEW.gst_treatment := CASE WHEN NEW.registration_type = 'composition' THEN 'registered_composition'
                              ELSE 'registered_regular' END;
  END IF;

  IF NEW.gst_treatment IS NULL THEN
    NEW.gst_treatment := CASE WHEN NEW.gstin IS NOT NULL THEN 'registered_regular'
                              WHEN NEW.uin IS NOT NULL THEN 'uin_holder'
                              WHEN NEW.country_code IS DISTINCT FROM 'IN' THEN 'overseas'
                              ELSE CASE WHEN TG_TABLE_NAME = 'suppliers' THEN 'unregistered' ELSE 'consumer' END END;
  ELSIF NOT explicit AND TG_OP = 'UPDATE' AND NEW.gstin IS DISTINCT FROM OLD.gstin THEN
    -- A GSTIN added or removed by an old caller moves the treatment with it.
    IF NEW.gstin IS NOT NULL AND NOT (NEW.gst_treatment = ANY (gstin_kinds)) THEN
      NEW.gst_treatment := 'registered_regular';
    ELSIF NEW.gstin IS NULL AND NEW.gst_treatment = ANY (gstin_kinds) THEN
      NEW.gst_treatment := CASE WHEN TG_TABLE_NAME = 'suppliers' THEN 'unregistered' ELSE 'consumer' END;
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

-- Named to sort before the server_seq / updated_at triggers (BEFORE triggers fire alphabetically).
CREATE TRIGGER customers_a_gst_treatment BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION app.derive_party_gst_treatment();
CREATE TRIGGER suppliers_a_gst_treatment BEFORE INSERT OR UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION app.derive_party_gst_treatment();

COMMENT ON COLUMN suppliers.registration_type IS
  'Deprecated (freeze §9a): mirrors gst_treatment via app.derive_party_gst_treatment until the contract migration.';

-- ===========================================================================
-- customer_addresses (freeze §3)
-- ===========================================================================

CREATE TABLE customer_addresses (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants (id),
  customer_id   UUID        NOT NULL,
  label         TEXT,
  line1         TEXT        NOT NULL CHECK (length(trim(line1)) > 0),
  line2         TEXT,
  city          TEXT        NOT NULL CHECK (length(trim(city)) > 0),
  country_code  TEXT        NOT NULL DEFAULT 'IN' CHECK (country_code ~ '^[A-Z]{2}$'),
  state_code    TEXT,
  postal_code   TEXT,
  ship_to_gstin TEXT,
  is_default    BOOLEAN     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  server_seq    BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT customer_addresses_domestic CHECK (
    country_code <> 'IN'
    OR (state_code IS NOT NULL AND postal_code IS NOT NULL
        AND state_code ~ '^[0-9]{2}$' AND postal_code ~ '^[1-9][0-9]{5}$')),
  CONSTRAINT customer_addresses_overseas CHECK (
    country_code = 'IN'
    OR (state_code IS NULL AND ship_to_gstin IS NULL AND postal_code IS NOT NULL)),
  CONSTRAINT customer_addresses_ship_to_gstin CHECK (
    ship_to_gstin IS NULL
    OR (state_code IS NOT NULL AND app.gstin_valid(ship_to_gstin) AND left(ship_to_gstin, 2) = state_code))
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (tenant_id, customer_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX customer_addresses_default_uq ON customer_addresses (tenant_id, customer_id)
  WHERE is_default AND deleted_at IS NULL;
SELECT app.setup_tenant_table('customer_addresses');

SELECT app.grant_runtime_privileges();
