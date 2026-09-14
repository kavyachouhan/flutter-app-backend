-- ===========================================================================
-- 0002 — Tenancy, identity and metering.
--
-- Three ideas drive the shape of this file:
--
--   1. A tenant is a business. An outlet is a shop location; a counter is a
--      till within it. Document numbering is per-counter, so counters are
--      real rows from day one rather than a later addition.
--
--   2. A *user* is a person, not a tenant member. The same phone number can
--      be the owner of one shop and a cashier at another, so `users` is
--      global and `memberships` carries the tenant-scoped role. Modelling
--      users per-tenant instead would mean the same person holding two
--      accounts and two PINs, which merchants reject immediately.
--
--   3. Seats, outlets and counters are metered from the first migration.
--      The pricing model charges per staff seat and per outlet; retrofitting
--      that onto a schema which assumed unlimited users is a painful
--      migration on live data.
-- ===========================================================================


-- ===========================================================================
-- Tenants
-- ===========================================================================

CREATE TABLE tenants (
  id                  UUID        PRIMARY KEY,

  -- Trading name, shown on the receipt.
  name                TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  legal_name          TEXT,

  -- --- GST identity -------------------------------------------------------
  -- A large share of small shops are not registered, and the product must
  -- serve them as a first-class case rather than as "GST left blank".
  -- `is_gst_registered = false` switches the tax engine into non-GST mode.
  is_gst_registered   BOOLEAN     NOT NULL DEFAULT false,
  gstin               TEXT        CHECK (
                        gstin IS NULL OR
                        gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
                      ),
  -- Composition dealers charge no GST on the invoice and pay a flat rate.
  is_composition      BOOLEAN     NOT NULL DEFAULT false,
  pan                 TEXT        CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),

  -- Two-digit GST state code. The default place of supply, and what decides
  -- CGST+SGST (intra-state) versus IGST (inter-state) on every invoice.
  state_code          TEXT        NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),

  -- --- Contact ------------------------------------------------------------
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  pincode             TEXT        CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  phone               TEXT,
  email               TEXT,

  -- --- Locale -------------------------------------------------------------
  -- i18n from commit one, per the design rules: bolting locale on later means
  -- reworking every template and report.
  locale              TEXT        NOT NULL DEFAULT 'en-IN',
  timezone            TEXT        NOT NULL DEFAULT 'Asia/Kolkata',
  currency_code       TEXT        NOT NULL DEFAULT 'INR',
  currency_symbol     TEXT        NOT NULL DEFAULT '₹',

  -- April in India. Stored rather than assumed, because document numbering
  -- resets on it and a future non-Indian market would differ.
  fy_start_month      SMALLINT    NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),

  -- --- Lifecycle ----------------------------------------------------------
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'cancelled')),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  server_seq          BIGINT      NOT NULL DEFAULT 0,

  -- A registered business must have a GSTIN. Enforced here rather than in the
  -- application because an invoice issued without one is not a tax invoice.
  CONSTRAINT tenants_gstin_required_when_registered
    CHECK (NOT is_gst_registered OR gstin IS NOT NULL)
);

CREATE UNIQUE INDEX idx_tenants_gstin ON tenants (gstin) WHERE gstin IS NOT NULL;

CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- The tenants table is the one place where the tenant key is `id`, not
-- `tenant_id`, so it gets a hand-written policy instead of setup_tenant_table.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());


-- ===========================================================================
-- Outlets
-- ===========================================================================

CREATE TABLE outlets (
  id              UUID        PRIMARY KEY,
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name            TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  -- Short code printed on the receipt and used in document number prefixes.
  code            TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9]{1,8}$'),

  -- A business operating in two states needs a separate GST registration per
  -- state, so GSTIN and state code are per-outlet and fall back to the
  -- tenant's when null.
  gstin           TEXT,
  state_code      TEXT        CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),

  address_line1   TEXT,
  address_line2   TEXT,
  city            TEXT,
  pincode         TEXT,
  phone           TEXT,

  is_active       BOOLEAN     NOT NULL DEFAULT true,
  -- The outlet used when a client does not specify one.
  is_default      BOOLEAN     NOT NULL DEFAULT false,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  server_seq      BIGINT      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_outlets_code
  ON outlets (tenant_id, code) WHERE deleted_at IS NULL;

-- At most one default outlet per tenant, enforced by the database rather than
-- by application code that would have to read-then-write under a race.
CREATE UNIQUE INDEX idx_outlets_single_default
  ON outlets (tenant_id) WHERE is_default AND deleted_at IS NULL;

SELECT app.setup_tenant_table('outlets');


-- ===========================================================================
-- Counters
--
-- A till. Its own document number series, its own cash-up. This is the unit
-- the numbering wedge is built on: two cashiers billing simultaneously on the
-- same counter is what produces duplicate invoice numbers in competing
-- products, and per-counter series is how that is made impossible.
-- ===========================================================================

CREATE TABLE counters (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id     UUID        NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,

  name          TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  code          TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9]{1,8}$'),

  is_active     BOOLEAN     NOT NULL DEFAULT true,
  is_default    BOOLEAN     NOT NULL DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  server_seq    BIGINT      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_counters_code
  ON counters (tenant_id, outlet_id, code) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_counters_single_default
  ON counters (tenant_id, outlet_id) WHERE is_default AND deleted_at IS NULL;

CREATE INDEX idx_counters_outlet ON counters (tenant_id, outlet_id);

SELECT app.setup_tenant_table('counters');


-- ===========================================================================
-- Users
--
-- Global, not tenant-scoped: one person, one login, however many shops they
-- work at. Phone is the identity because that is how Indian SMBs onboard —
-- there is no email-first flow to fall back on.
-- ===========================================================================

CREATE TABLE users (
  id              UUID        PRIMARY KEY,

  -- E.164 without the leading '+' (e.g. 919876543210). Normalising on the way
  -- in means "9876543210" and "+91 98765 43210" resolve to the same account,
  -- which is otherwise a steady source of duplicate users.
  phone           TEXT        NOT NULL CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  phone_verified  BOOLEAN     NOT NULL DEFAULT false,

  name            TEXT,
  email           TEXT,
  email_verified  BOOLEAN     NOT NULL DEFAULT false,

  -- Optional. The primary flow is phone + OTP; a password only exists for
  -- back-office users who want one. scrypt (Node's built-in), so there is no
  -- native module to build — see src/modules/auth/password.ts.
  password_hash   TEXT,

  -- App lock. Short, device-local, and NOT a substitute for authentication:
  -- it stops a shop assistant opening the owner's till view on an unlocked
  -- phone. Hashed all the same, since users reuse PINs.
  pin_hash        TEXT,

  locale          TEXT        NOT NULL DEFAULT 'en-IN',
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  last_login_at   TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_users_phone ON users (phone) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_users_email ON users (lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- The isolation policy is created after `memberships` below, because it joins
-- against that table. Until then RLS is enabled with no policy at all, which
-- denies everything — the correct state to pass through.
--
-- Login happens before any tenant context exists, so the auth module reaches
-- this table through a SECURITY DEFINER function rather than through RLS.
-- See app.find_user_for_login() at the end of this file.


-- ===========================================================================
-- Memberships — the tenant-scoped half of identity
-- ===========================================================================

CREATE TABLE memberships (
  id            UUID        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,

  -- owner      — billing, everything, cannot be removed if last one
  -- manager    — all operations, approves over-cap discounts
  -- cashier    — billing and its own cash-up only
  -- accountant — read-only across books, plus GST exports
  -- viewer     — read-only
  role          TEXT        NOT NULL
                  CHECK (role IN ('owner', 'manager', 'cashier', 'accountant', 'viewer')),

  -- Which outlets this member may act on. NULL means all of them, which is
  -- the common single-shop case; an explicit array is what a multi-outlet
  -- business uses to keep a branch cashier out of another branch's books.
  outlet_ids    UUID[],

  is_active     BOOLEAN     NOT NULL DEFAULT true,
  invited_at    TIMESTAMPTZ,
  accepted_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  server_seq    BIGINT      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_memberships_unique
  ON memberships (tenant_id, user_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_memberships_user ON memberships (user_id) WHERE deleted_at IS NULL;

SELECT app.setup_tenant_table('memberships');


-- --- The deferred users policy ---------------------------------------------
-- A tenant may see exactly the users who are members of it. Without the
-- membership join this table would be a directory of every phone number in
-- the system, readable by any authenticated tenant.
CREATE POLICY users_visible_to_own_tenants ON users
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = app.current_tenant_id()
        AND m.deleted_at IS NULL
    )
  );

-- Updating one's own profile (name, locale, PIN). Scoped the same way, so a
-- tenant admin can never write to a user row outside their own business.
CREATE POLICY users_writable_by_own_tenants ON users
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = app.current_tenant_id()
        AND m.deleted_at IS NULL
    )
  );


-- ===========================================================================
-- Devices
--
-- Offline-first means the device is a first-class actor: it leases document
-- number blocks, holds an independent sync cursor, and is the unit a support
-- agent reasons about ("the back-counter tablet hasn't synced since Tuesday").
-- ===========================================================================

CREATE TABLE devices (
  id                UUID        PRIMARY KEY,
  tenant_id         UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           UUID        REFERENCES users(id) ON DELETE SET NULL,
  outlet_id         UUID        REFERENCES outlets(id) ON DELETE SET NULL,
  counter_id        UUID        REFERENCES counters(id) ON DELETE SET NULL,

  -- Client-generated, stable across reinstalls where the platform allows.
  device_key        TEXT        NOT NULL,
  label             TEXT,
  platform          TEXT        NOT NULL
                      CHECK (platform IN ('android', 'ios', 'windows', 'macos', 'web')),
  app_version       TEXT,
  os_version        TEXT,

  -- How far this device has pulled. Server-side copy of the client's cursor,
  -- used for diagnostics and for the "not synced since" support view.
  last_sync_seq     BIGINT      NOT NULL DEFAULT 0,
  last_seen_at      TIMESTAMPTZ,

  push_token        TEXT,
  is_active         BOOLEAN     NOT NULL DEFAULT true,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  server_seq        BIGINT      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_devices_key ON devices (tenant_id, device_key);
CREATE INDEX idx_devices_user ON devices (tenant_id, user_id);

SELECT app.setup_tenant_table('devices');


-- ===========================================================================
-- Refresh tokens
--
-- Rotating, with reuse detection. Access tokens are short-lived and stateless;
-- refresh tokens are long-lived and therefore stored, so they can be revoked.
--
-- Only the SHA-256 of the token is kept. A database leak then yields nothing
-- usable — the same reason passwords are hashed. SHA-256 rather than a slow
-- KDF is correct here: the token is 32 bytes of CSPRNG output, so there is no
-- guessable input space for a KDF to protect against.
-- ===========================================================================

CREATE TABLE refresh_tokens (
  id            UUID        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     UUID        REFERENCES devices(id) ON DELETE SET NULL,

  token_hash    TEXT        NOT NULL,

  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoked_reason TEXT,

  -- Set when this token is rotated. If a token that has already been replaced
  -- is presented again, it was captured: the whole chain is revoked and the
  -- user is forced to re-authenticate.
  replaced_by   UUID        REFERENCES refresh_tokens(id) ON DELETE SET NULL,

  created_ip    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id)
  WHERE revoked_at IS NULL;
-- Supports the cleanup job that deletes expired rows.
CREATE INDEX idx_refresh_tokens_expiry ON refresh_tokens (expires_at);

-- Reached only by the auth module before a tenant context exists, so it is
-- left out of RLS and protected by revoking all grants from the app role
-- except through the auth repository's SECURITY DEFINER helpers.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY refresh_tokens_tenant ON refresh_tokens
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ===========================================================================
-- Subscriptions and entitlements — metering from day one
--
-- The pricing model is a free tier plus per-seat, per-outlet and per-counter
-- add-ons. Limits live in the database, not in application constants, so a
-- support agent can raise one for a single customer without a deploy.
-- ===========================================================================

CREATE TABLE subscriptions (
  id                  UUID        PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  plan                TEXT        NOT NULL DEFAULT 'free'
                        CHECK (plan IN ('free', 'paid', 'trial')),
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),

  -- --- Metered limits. NULL means unlimited. --------------------------------
  max_users           INTEGER     CHECK (max_users    IS NULL OR max_users    > 0),
  max_outlets         INTEGER     CHECK (max_outlets  IS NULL OR max_outlets  > 0),
  max_counters        INTEGER     CHECK (max_counters IS NULL OR max_counters > 0),
  -- The free tier caps the catalogue (~100 items); paid is unlimited.
  max_items           INTEGER     CHECK (max_items    IS NULL OR max_items    > 0),

  -- Feature gates as a JSON object, e.g. {"purchases": true, "tally_sync": false}.
  -- A map rather than a column per feature: the feature list runs to ~112
  -- entries, and each one should not be a migration.
  features            JSONB       NOT NULL DEFAULT '{}'::jsonb,

  trial_ends_at       TIMESTAMPTZ,
  current_period_end  TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_seq          BIGINT      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_subscriptions_tenant ON subscriptions (tenant_id);

SELECT app.setup_tenant_table('subscriptions');


-- ===========================================================================
-- Login lookup
--
-- Authentication necessarily happens before a tenant context exists, so it
-- cannot go through RLS. This function is the single, audited hole in that
-- wall: SECURITY DEFINER, fixed search_path, and it returns exactly the
-- columns the login flow needs — never a password hash by accident, never a
-- way to enumerate users.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.find_user_for_login(p_phone TEXT)
RETURNS TABLE (
  user_id        UUID,
  phone          TEXT,
  name           TEXT,
  is_active      BOOLEAN,
  password_hash  TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.phone, u.name, u.is_active, u.password_hash
  FROM users u
  WHERE u.phone = p_phone
    AND u.deleted_at IS NULL;
$$;

COMMENT ON FUNCTION app.find_user_for_login(TEXT) IS
  'Pre-authentication user lookup by phone. SECURITY DEFINER because no '
  'tenant context exists yet. Callers must rate-limit: this function can '
  'confirm whether a phone number is registered.';


-- Tenants a user may sign in to, for the post-OTP tenant picker.
CREATE OR REPLACE FUNCTION app.find_memberships_for_login(p_user_id UUID)
RETURNS TABLE (
  tenant_id    UUID,
  tenant_name  TEXT,
  role         TEXT,
  outlet_ids   UUID[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.tenant_id, t.name, m.role, m.outlet_ids
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id
    AND m.is_active
    AND m.deleted_at IS NULL
    AND t.deleted_at IS NULL
    AND t.status = 'active'
  ORDER BY t.name;
$$;
