-- 0002 — Tenancy, identity, devices, sessions and plan metering.
--
-- A user is a person, global across tenants: the same phone can own one shop
-- and work a till at another. Tenant-scoped role and outlet access live on
-- `memberships`. Seats, outlets and counters are metered from this migration
-- because per-seat pricing cannot be retrofitted onto live data cheaply.

SET LOCAL search_path = public, extensions;

CREATE TABLE tenants (
  id                         UUID        PRIMARY KEY,
  name                       TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  legal_name                 TEXT,

  -- Unregistered shops are a first-class mode, not GST with blank fields.
  is_gst_registered          BOOLEAN     NOT NULL,
  gstin                      TEXT        CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  is_composition             BOOLEAN     NOT NULL,
  pan                        TEXT        CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  -- GST state code: decides CGST+SGST versus IGST on every invoice.
  state_code                 TEXT        NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),

  address_line1              TEXT,
  address_line2              TEXT,
  city                       TEXT,
  pincode                    TEXT,
  phone                      TEXT,
  email                      TEXT,

  locale                     TEXT        NOT NULL,
  timezone                   TEXT        NOT NULL,
  currency_code              TEXT        NOT NULL,
  currency_symbol            TEXT        NOT NULL,
  -- Document numbering resets on this month.
  fy_start_month             SMALLINT    NOT NULL CHECK (fy_start_month BETWEEN 1 AND 12),

  allow_negative_stock       BOOLEAN     NOT NULL,
  default_prices_include_tax BOOLEAN     NOT NULL,

  status                     TEXT        NOT NULL CHECK (status IN ('active', 'suspended', 'cancelled')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                 TIMESTAMPTZ,
  server_seq                 BIGINT      NOT NULL DEFAULT 0,

  -- An invoice from a registered dealer without a GSTIN is not a tax invoice.
  CONSTRAINT tenants_gstin_when_registered CHECK (NOT is_gst_registered OR gstin IS NOT NULL),
  CONSTRAINT tenants_composition_requires_registration CHECK (NOT is_composition OR is_gst_registered)
);

CREATE UNIQUE INDEX tenants_gstin_uq ON tenants (gstin) WHERE gstin IS NOT NULL AND deleted_at IS NULL;

-- The tenant key here is `id`, so the standard helper does not apply.
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE FUNCTION app.stamp_tenant_seq() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, app
AS $$ BEGIN NEW.server_seq := app.next_server_seq(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER tenants_server_seq BEFORE INSERT OR UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.stamp_tenant_seq();

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());


CREATE TABLE outlets (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants (id),
  name          TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  code          TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9]+$'),
  -- A business trading in two states holds a GST registration per state, so
  -- these override the tenant's when present.
  gstin         TEXT,
  state_code    TEXT        CHECK (state_code ~ '^[0-9]{2}$'),
  address_line1 TEXT,
  address_line2 TEXT,
  city          TEXT,
  pincode       TEXT,
  phone         TEXT,
  is_active     BOOLEAN     NOT NULL,
  is_default    BOOLEAN     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  server_seq    BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX outlets_code_uq ON outlets (tenant_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX outlets_default_uq ON outlets (tenant_id) WHERE is_default AND deleted_at IS NULL;
SELECT app.setup_tenant_table('outlets');


-- A till. Each counter has its own number series, which is what stops two
-- cashiers billing at once from issuing the same invoice number.
CREATE TABLE counters (
  id          UUID        PRIMARY KEY,
  tenant_id   UUID        NOT NULL,
  outlet_id   UUID        NOT NULL,
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  code        TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9]+$'),
  is_active   BOOLEAN     NOT NULL,
  is_default  BOOLEAN     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  server_seq  BIGINT      NOT NULL DEFAULT 0,
  -- Composite FK: a counter can never point at another tenant's outlet, even
  -- though RI checks themselves bypass RLS.
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX counters_code_uq ON counters (tenant_id, outlet_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX counters_default_uq ON counters (tenant_id, outlet_id) WHERE is_default AND deleted_at IS NULL;
SELECT app.setup_tenant_table('counters');


CREATE TABLE users (
  id             UUID        PRIMARY KEY,
  -- E.164 digits without "+", normalised on the way in so formatting
  -- variations of one number cannot create duplicate accounts.
  phone          TEXT        NOT NULL CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  phone_verified BOOLEAN     NOT NULL DEFAULT false,
  name           TEXT,
  email          TEXT,
  -- NULL falls back to the tenant's locale.
  locale         TEXT,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


CREATE TABLE memberships (
  id          UUID        PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  user_id     UUID        NOT NULL REFERENCES users (id),
  role        TEXT        NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'accountant', 'viewer')),
  -- NULL means every outlet; an array confines a branch cashier to their branch.
  outlet_ids  UUID[],
  is_active   BOOLEAN     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  server_seq  BIGINT      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX memberships_user_uq ON memberships (tenant_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE deleted_at IS NULL;
SELECT app.setup_tenant_table('memberships');

-- Without the membership join, `users` would be a directory of every phone
-- number on the platform readable by any tenant. There is no INSERT policy:
-- users are only created through app.ensure_user().
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT USING (
  EXISTS (SELECT 1 FROM memberships m
          WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id() AND m.deleted_at IS NULL));
CREATE POLICY users_update ON users FOR UPDATE USING (
  EXISTS (SELECT 1 FROM memberships m
          WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id() AND m.deleted_at IS NULL));


-- Offline-first makes the device an actor: it leases number blocks and holds
-- its own sync cursor.
CREATE TABLE devices (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants (id),
  user_id       UUID        REFERENCES users (id),
  outlet_id     UUID,
  counter_id    UUID,
  -- Client-generated and stable across app restarts.
  device_key    TEXT        NOT NULL,
  label         TEXT,
  platform      TEXT        NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'macos', 'web')),
  app_version   TEXT,
  os_version    TEXT,
  last_sync_seq BIGINT      NOT NULL DEFAULT 0,
  last_seen_at  TIMESTAMPTZ,
  is_active     BOOLEAN     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  server_seq    BIGINT      NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES counters (tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX devices_key_uq ON devices (tenant_id, device_key);
SELECT app.setup_tenant_table('devices');


-- Only the SHA-256 of a refresh token is stored. SHA-256 rather than a slow
-- KDF is correct here: the token is CSPRNG output with no guessable input space.
CREATE TABLE refresh_tokens (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  user_id        UUID        NOT NULL REFERENCES users (id),
  device_id      UUID        NOT NULL,
  token_hash     TEXT        NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  -- Presenting a token that was already rotated means it was copied: the
  -- device's whole session is revoked.
  replaced_by    UUID        REFERENCES refresh_tokens (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

CREATE UNIQUE INDEX refresh_tokens_hash_uq ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_device_idx ON refresh_tokens (tenant_id, device_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refresh_tokens
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- Limits live in rows, not code, so support can raise one customer's limit
-- without a deploy. NULL means unlimited.
CREATE TABLE subscriptions (
  id                 UUID        PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  plan               TEXT        NOT NULL CHECK (plan IN ('free', 'trial', 'paid')),
  status             TEXT        NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
  max_users          INTEGER     CHECK (max_users > 0),
  max_outlets        INTEGER     CHECK (max_outlets > 0),
  max_counters       INTEGER     CHECK (max_counters > 0),
  max_items          INTEGER     CHECK (max_items > 0),
  -- A map rather than a column per feature: the backlog runs past a hundred.
  features           JSONB       NOT NULL,
  trial_ends_at      TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq         BIGINT      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX subscriptions_tenant_uq ON subscriptions (tenant_id);
SELECT app.setup_tenant_table('subscriptions');


-- ===========================================================================
-- Pre-authentication access
--
-- Login happens before any tenant context exists, so it cannot pass through
-- RLS. These SECURITY DEFINER functions are the only holes in that wall, and
-- each returns just the columns its flow needs.
--
-- They run as the migration owner, which on Supabase is `postgres` with
-- BYPASSRLS; that attribute is what lets them read past FORCE ROW LEVEL SECURITY.
-- ===========================================================================

CREATE FUNCTION app.ensure_user(p_id UUID, p_phone TEXT, p_name TEXT)
RETURNS TABLE (user_id UUID, is_active BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO users (id, phone, name) VALUES (p_id, p_phone, p_name)
  ON CONFLICT (phone) WHERE deleted_at IS NULL DO NOTHING;

  RETURN QUERY
    UPDATE users u SET name = COALESCE(u.name, p_name)
    WHERE u.phone = p_phone AND u.deleted_at IS NULL
    RETURNING u.id, u.is_active;
END $$;

CREATE FUNCTION app.record_login(p_user_id UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ UPDATE users SET phone_verified = true, last_login_at = now() WHERE id = p_user_id $$;

CREATE FUNCTION app.find_memberships_for_login(p_user_id UUID)
RETURNS TABLE (tenant_id UUID, tenant_name TEXT, role TEXT, outlet_ids UUID[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT m.tenant_id, t.name, m.role, m.outlet_ids
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND m.is_active AND m.deleted_at IS NULL
    AND t.deleted_at IS NULL AND t.status = 'active'
  ORDER BY t.name;
$$;

CREATE FUNCTION app.find_refresh_token(p_token_hash TEXT)
RETURNS TABLE (id UUID, tenant_id UUID, user_id UUID, device_id UUID,
               expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, replaced_by UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT id, tenant_id, user_id, device_id, expires_at, revoked_at, replaced_by
  FROM refresh_tokens WHERE token_hash = p_token_hash;
$$;

SELECT app.grant_runtime_privileges();
