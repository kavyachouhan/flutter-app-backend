-- 0037 — GST registrations, legal-entity turnover and the dated GST rule set (A0b).
--
-- Implements docs/gst/A0A_ARCHITECTURE_FREEZE.md §1, §2, §6 and the §9 preflight guard, under
-- the §9a "expand now, contract later" amendment: every new table and constraint is added and
-- backfilled; nothing existing is dropped.
--
-- Table contract:
--   gst_rule_sets          global, versioned (effective_from, revision) snapshots of GST rules.
--                          Published, withdrawn and legacy rows are immutable. The 'legacy'
--                          row labels migrated documents and encodes no rules.
--   hsn_master             global HSN/SAC codes and descriptions; no rates (freeze §6.3).
--   gst_registrations      one row per GSTIN a tenant (legal entity, one PAN) holds.
--   gst_registration_profiles
--                          effective-dated scheme / filing frequency per registration;
--                          half-open [effective_from, effective_to) ranges that never overlap.
--   gst_period_lock_events append-only record of return-period locks and reopens (D12, D33).
--   entity_turnover_by_fy  PAN-level aggregate turnover per FY with its source (D20, D23).
--   outlets.registration_id the registration an outlet bills under.
--
-- Transition (freeze §9a): the tenant and outlet APIs still write tenants.gstin /
-- is_composition / filing_frequency and outlets.gstin. AFTER triggers call
-- app.sync_tenant_registrations() so the registration tables follow every such write.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- GSTIN / UIN validation (must agree with src/domain/gst/gstin.ts on contracts/gstin-vectors.json)
-- ===========================================================================

CREATE FUNCTION app.gstin_valid(p_gstin TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$
DECLARE
  alphabet CONSTANT TEXT := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  state INTEGER;
  total INTEGER := 0;
  product INTEGER;
BEGIN
  IF p_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
    RETURN false;
  END IF;
  state := substr(p_gstin, 1, 2)::INTEGER;
  IF NOT ((state BETWEEN 1 AND 38) OR state IN (97, 99)) THEN
    RETURN false;
  END IF;
  -- GSTN mod-36: weights alternate 1, 2 from the left; each product is folded base 36.
  FOR i IN 0..13 LOOP
    product := (strpos(alphabet, substr(p_gstin, i + 1, 1)) - 1) * CASE WHEN i % 2 = 0 THEN 1 ELSE 2 END;
    total := total + product / 36 + product % 36;
  END LOOP;
  RETURN substr(alphabet, (36 - total % 36) % 36 + 1, 1) = substr(p_gstin, 15, 1);
END $$;

COMMENT ON FUNCTION app.gstin_valid(TEXT) IS
  'Format, state code (01-38, 97, 99) and GSTN mod-36 check character. Mirrors src/domain/gst/gstin.ts.';

-- Provisional format (freeze open item U1): 15 upper-case alphanumerics, no checksum.
CREATE FUNCTION app.uin_valid(p_uin TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT p_uin ~ '^[0-9A-Z]{15}$' $$;

-- ===========================================================================
-- Preflight guard (freeze §9 step 0): refuse to run over ambiguous registration data.
-- The read-only report is src/db/preflight/gst-registrations.ts; these are its blocking checks.
-- ===========================================================================

DO $$
DECLARE
  problems TEXT[] := ARRAY[]::TEXT[];
  n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT gstin FROM (SELECT id AS tenant_id, gstin FROM tenants WHERE gstin IS NOT NULL
                       UNION SELECT tenant_id, gstin FROM outlets WHERE gstin IS NOT NULL) g
     GROUP BY gstin HAVING count(DISTINCT tenant_id) > 1) x;
  IF n > 0 THEN problems := problems || format('%s GSTIN(s) held by more than one tenant', n); END IF;

  SELECT count(*) INTO n FROM outlets o JOIN tenants t ON t.id = o.tenant_id
   WHERE o.deleted_at IS NULL AND COALESCE(o.gstin, t.gstin) IS NOT NULL
     AND left(COALESCE(o.gstin, t.gstin), 2) IS DISTINCT FROM COALESCE(o.state_code, t.state_code);
  IF n > 0 THEN problems := problems || format('%s outlet(s) whose GSTIN prefix differs from their state', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT gstin FROM tenants WHERE gstin IS NOT NULL
    UNION ALL SELECT gstin FROM outlets WHERE gstin IS NOT NULL AND deleted_at IS NULL) g
   WHERE NOT app.gstin_valid(gstin);
  IF n > 0 THEN problems := problems || format('%s tenant/outlet GSTIN(s) fail format or checksum', n); END IF;

  SELECT count(*) INTO n FROM tenants t
   WHERE NOT t.is_gst_registered
     AND (t.gstin IS NOT NULL OR EXISTS (SELECT 1 FROM outlets o
                                          WHERE o.tenant_id = t.id AND o.gstin IS NOT NULL AND o.deleted_at IS NULL));
  IF n > 0 THEN problems := problems || format('%s unregistered tenant(s) holding a GSTIN', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT o.tenant_id FROM outlets o JOIN tenants t ON t.id = o.tenant_id
     WHERE t.is_composition AND o.deleted_at IS NULL AND COALESCE(o.gstin, t.gstin) IS NOT NULL
     GROUP BY o.tenant_id HAVING count(DISTINCT COALESCE(o.gstin, t.gstin)) > 1) x;
  IF n > 0 THEN problems := problems || format('%s composition tenant(s) with several GSTINs', n); END IF;

  SELECT count(*) INTO n FROM outlets o JOIN tenants t ON t.id = o.tenant_id
   WHERE COALESCE(o.gstin, t.gstin) IS NULL
     AND EXISTS (SELECT 1 FROM outlets o2 WHERE o2.tenant_id = t.id AND o2.gstin IS NOT NULL UNION ALL
                 SELECT 1 WHERE t.gstin IS NOT NULL)
     AND (EXISTS (SELECT 1 FROM invoices d WHERE d.outlet_id = o.id)
       OR EXISTS (SELECT 1 FROM credit_notes d WHERE d.outlet_id = o.id)
       OR EXISTS (SELECT 1 FROM purchase_bills d WHERE d.outlet_id = o.id)
       OR EXISTS (SELECT 1 FROM debit_notes d WHERE d.outlet_id = o.id));
  IF n > 0 THEN problems := problems || format('%s outlet(s) with documents but no registration', n); END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'GST registration preflight failed: %. Run src/db/preflight/gst-registrations.ts for the report.',
      array_to_string(problems, '; ');
  END IF;
END $$;

-- ===========================================================================
-- Global rule set and HSN master (freeze §6)
-- ===========================================================================

-- no-tenant-setup: gst_rule_sets — global reference data, served by version endpoints, not the tenant change stream
CREATE TABLE gst_rule_sets (
  version          TEXT        PRIMARY KEY,
  effective_from   DATE        NOT NULL,
  revision         INTEGER     NOT NULL CHECK (revision >= 1),
  supersedes       TEXT        REFERENCES gst_rule_sets (version),
  status           TEXT        NOT NULL CHECK (status IN ('draft', 'published', 'withdrawn', 'legacy')),
  content          JSONB       NOT NULL,
  content_sha256   TEXT        NOT NULL,
  published_at     TIMESTAMPTZ,
  published_by     TEXT,
  withdrawn_at     TIMESTAMPTZ,
  withdrawn_by     TEXT,
  withdrawn_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (effective_from, revision),
  CHECK (version = 'legacy' OR version = to_char(effective_from, 'YYYY-MM-DD') || '.' || revision),
  CHECK (supersedes IS NULL OR revision > 1),
  CHECK (content_sha256 = encode(sha256(convert_to(content::TEXT, 'UTF8')), 'hex')),
  CHECK ((status = 'published') <= (published_at IS NOT NULL)),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
);

CREATE FUNCTION app.guard_gst_rule_set() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'GST rule set % is %; only drafts may be deleted', OLD.version, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (NEW.version, NEW.effective_from, NEW.revision, NEW.supersedes, NEW.content, NEW.content_sha256)
     IS DISTINCT FROM (OLD.version, OLD.effective_from, OLD.revision, OLD.supersedes, OLD.content, OLD.content_sha256) THEN
    RAISE EXCEPTION 'GST rule set % is % and immutable; publish a new revision instead', OLD.version, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'published' AND NEW.status = 'withdrawn') THEN
      RAISE EXCEPTION 'GST rule set % cannot move from % to %', OLD.version, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- No date may lose coverage: withdraw only a future version, or one already replaced
    -- by a later published revision of the same effective date.
    IF OLD.effective_from <= current_date AND NOT EXISTS (
         SELECT 1 FROM gst_rule_sets r
          WHERE r.effective_from = OLD.effective_from AND r.revision > OLD.revision AND r.status = 'published') THEN
      RAISE EXCEPTION 'GST rule set % is in force; publish its replacement revision before withdrawing it', OLD.version
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gst_rule_sets_guard BEFORE UPDATE OR DELETE ON gst_rule_sets
  FOR EACH ROW EXECUTE FUNCTION app.guard_gst_rule_set();

ALTER TABLE gst_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_rule_sets FORCE ROW LEVEL SECURITY;
-- Every tenant may read published rules; nothing at runtime may write them (no write policy).
CREATE POLICY gst_rule_sets_read ON gst_rule_sets FOR SELECT USING (status <> 'draft');

-- The label for migrated documents: no rates, no rules; never selected, never evaluated.
INSERT INTO gst_rule_sets (version, effective_from, revision, status, content, content_sha256)
SELECT 'legacy', DATE '2017-07-01', 1, 'legacy', c, encode(sha256(convert_to(c::TEXT, 'UTF8')), 'hex')
  FROM (SELECT jsonb_build_object(
          'allowedRates', '[]'::JSONB, 'taxRates', '[]'::JSONB,
          'cess', jsonb_build_object('allowedUntil', '2017-06-30', 'notificationRef', 'LEGACY',
                                     'verificationStatus', 'secondary_only', 'history', '[]'::JSONB),
          'thresholds', '[]'::JSONB, 'stateCodes', '[]'::JSONB, 'uqc', '[]'::JSONB,
          'rcmCategories', '[]'::JSONB, 'blockedCredits', '[]'::JSONB, 'einvoiceExclusions', '[]'::JSONB,
          'validationRules', '[]'::JSONB, 'gstr1aAmendableFields', '{}'::JSONB,
          'ewbIntraStateThresholds', '[]'::JSONB) AS c) x;

-- no-tenant-setup: hsn_master — global reference data, served by version endpoint
CREATE TABLE hsn_master (
  code           TEXT        PRIMARY KEY CHECK (code ~ '^[0-9]{2,8}$'),
  kind           TEXT        NOT NULL CHECK (kind IN ('goods', 'service')),
  description    TEXT        NOT NULL,
  parent_code    TEXT,
  source_version TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE hsn_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE hsn_master FORCE ROW LEVEL SECURITY;
CREATE POLICY hsn_master_read ON hsn_master FOR SELECT USING (true);

-- ===========================================================================
-- Legal entity (PAN level): turnover by FY (freeze §1)
-- ===========================================================================

ALTER TABLE tenants ADD COLUMN einvoice_exemption_category TEXT NOT NULL DEFAULT 'none'
  CHECK (einvoice_exemption_category IN ('none', 'bank_nbfc_insurer', 'gta', 'passenger_transport',
                                         'multiplex_admission', 'government_local_authority'));

CREATE TABLE entity_turnover_by_fy (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  fy_start_year      INTEGER     NOT NULL CHECK (fy_start_year BETWEEN 2017 AND 2100),
  -- Paise; aggregate turnover under s.2(6) across every GSTIN on the PAN.
  aggregate_turnover BIGINT      NOT NULL CHECK (aggregate_turnover >= 0),
  source             TEXT        NOT NULL CHECK (source IN ('declared', 'app_computed', 'portal_verified')),
  verified_by        UUID        REFERENCES users (id),
  verified_at        TIMESTAMPTZ,
  evidence_ref       TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fy_start_year, source),
  CHECK ((source = 'portal_verified') <= (verified_at IS NOT NULL))
);
SELECT app.setup_tenant_table('entity_turnover_by_fy');

-- ===========================================================================
-- GST registrations (freeze §2)
-- ===========================================================================

CREATE TABLE gst_registrations (
  id                      UUID        PRIMARY KEY,
  tenant_id               UUID        NOT NULL REFERENCES tenants (id),
  gstin                   TEXT        NOT NULL CHECK (app.gstin_valid(gstin)),
  state_code              TEXT        NOT NULL,
  legal_name              TEXT,
  trade_name              TEXT,
  registration_kind       TEXT        NOT NULL DEFAULT 'normal'
                          CHECK (registration_kind IN ('normal', 'casual', 'isd_reserved', 'tds_tcs_reserved')),
  is_sez_unit             BOOLEAN     NOT NULL DEFAULT false,
  is_sez_developer        BOOLEAN     NOT NULL DEFAULT false,
  status                  TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  effective_from          DATE        NOT NULL,
  -- Exclusive: the registration is in force on [effective_from, effective_to).
  effective_to            DATE,
  round_off_enabled       BOOLEAN     NOT NULL DEFAULT true,
  offline_backdate_policy TEXT        NOT NULL DEFAULT 'audited_late_sync'
                          CHECK (offline_backdate_policy IN ('audited_late_sync', 'strict_close')),
  lock_epoch              BIGINT      NOT NULL DEFAULT 0 CHECK (lock_epoch >= 0),
  gstr1_locked_through    DATE,
  gstr3b_locked_through   DATE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ,
  server_seq              BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  CONSTRAINT gst_registrations_state_prefix CHECK (state_code = left(gstin, 2)),
  CHECK (NOT (is_sez_unit AND is_sez_developer)),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX gst_registrations_gstin_uq ON gst_registrations (gstin) WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('gst_registrations');

CREATE TABLE gst_registration_profiles (
  id                       UUID        PRIMARY KEY,
  tenant_id                UUID        NOT NULL,
  registration_id          UUID        NOT NULL,
  effective_from           DATE        NOT NULL,
  effective_to             DATE,
  taxpayer_scheme          TEXT        NOT NULL CHECK (taxpayer_scheme IN ('regular', 'composition')),
  composition_category     TEXT        CHECK (composition_category IN ('trader', 'manufacturer', 'restaurant', 'service')),
  composition_rate_percent NUMERIC(5, 2) CHECK (composition_rate_percent >= 0),
  filing_frequency         TEXT        NOT NULL CHECK (filing_frequency IN ('monthly', 'qrmp')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq               BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((taxpayer_scheme = 'composition') = (composition_rate_percent IS NOT NULL)),
  -- Half-open ranges: a profile ending on 2026-04-01 and the next starting that day do not overlap.
  EXCLUDE USING gist (registration_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);
SELECT app.setup_tenant_table('gst_registration_profiles');

CREATE TABLE gst_period_lock_events (
  id              UUID        PRIMARY KEY,
  tenant_id       UUID        NOT NULL,
  registration_id UUID        NOT NULL,
  lock_level      TEXT        NOT NULL CHECK (lock_level IN ('gstr1_filed', 'gstr3b_filed')),
  event           TEXT        NOT NULL CHECK (event IN ('lock', 'reopen')),
  locked_through  DATE        NOT NULL,
  lock_epoch      BIGINT      NOT NULL CHECK (lock_epoch >= 1),
  reason          TEXT,
  created_by      UUID        NOT NULL REFERENCES users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq      BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (registration_id, lock_epoch),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id),
  CHECK ((event = 'reopen') <= (reason IS NOT NULL))
);
SELECT app.setup_tenant_table('gst_period_lock_events');
SELECT app.restrict_table('gst_period_lock_events', ARRAY['UPDATE', 'DELETE']);

ALTER TABLE outlets ADD COLUMN registration_id UUID;
ALTER TABLE outlets ADD CONSTRAINT outlets_registration_fk
  FOREIGN KEY (tenant_id, registration_id) REFERENCES gst_registrations (tenant_id, id);

-- ===========================================================================
-- Transition sync (freeze §9a): the old tenant/outlet columns are still the write path.
-- ===========================================================================

CREATE FUNCTION app.sync_tenant_registrations(p_tenant UUID) RETURNS VOID
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
              CASE WHEN g.gstin = t.gstin THEN COALESCE(t.registration_effective_from, current_date) ELSE current_date END)
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

CREATE FUNCTION app.sync_tenant_registrations_trigger() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM app.sync_tenant_registrations(CASE WHEN TG_TABLE_NAME = 'tenants' THEN NEW.id ELSE NEW.tenant_id END);
  RETURN NULL;
END $$;

CREATE TRIGGER tenants_sync_registrations
  AFTER INSERT OR UPDATE OF gstin, is_gst_registered, is_composition, composition_category,
                            composition_rate_percent, filing_frequency, name, legal_name
  ON tenants FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_registrations_trigger();
CREATE TRIGGER outlets_sync_registrations
  AFTER INSERT OR UPDATE OF gstin, state_code, deleted_at
  ON outlets FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_registrations_trigger();

-- ===========================================================================
-- Backfill: one registration per GSTIN in use, profiles from the tenant's scheme
-- ===========================================================================

-- Registrations from the preflight-approved data; dates as the preflight derives them.
INSERT INTO gst_registrations (id, tenant_id, gstin, state_code, legal_name, trade_name, effective_from)
SELECT gen_random_uuid(), t.id, g.gstin, left(g.gstin, 2), t.legal_name, t.name,
       CASE WHEN g.gstin = t.gstin THEN COALESCE(t.registration_effective_from, DATE '2017-07-01')
            ELSE DATE '2017-07-01' END
  FROM tenants t
  JOIN (SELECT DISTINCT o.tenant_id, COALESCE(o.gstin, t2.gstin) AS gstin
          FROM outlets o JOIN tenants t2 ON t2.id = o.tenant_id
         WHERE o.deleted_at IS NULL AND COALESCE(o.gstin, t2.gstin) IS NOT NULL
        UNION
        SELECT id, gstin FROM tenants WHERE gstin IS NOT NULL) g ON g.tenant_id = t.id
 WHERE t.is_gst_registered;

INSERT INTO gst_registration_profiles (id, tenant_id, registration_id, effective_from, taxpayer_scheme,
                                       composition_category, composition_rate_percent, filing_frequency)
SELECT gen_random_uuid(), r.tenant_id, r.id, r.effective_from,
       CASE WHEN t.is_composition THEN 'composition' ELSE 'regular' END,
       CASE WHEN t.is_composition THEN t.composition_category END,
       CASE WHEN t.is_composition THEN t.composition_rate_percent END,
       t.filing_frequency
  FROM gst_registrations r JOIN tenants t ON t.id = r.tenant_id;

UPDATE outlets o
   SET registration_id = r.id
  FROM tenants t, gst_registrations r
 WHERE t.id = o.tenant_id AND r.tenant_id = o.tenant_id AND r.gstin = COALESCE(o.gstin, t.gstin);

COMMENT ON COLUMN outlets.gstin IS
  'Deprecated (freeze §9a): still the write path until A3; app.sync_tenant_registrations keeps outlets.registration_id in step.';
COMMENT ON COLUMN tenants.gstin IS
  'Deprecated (freeze §9a): registrations live in gst_registrations; kept in step by app.sync_tenant_registrations.';

SELECT app.grant_runtime_privileges();
