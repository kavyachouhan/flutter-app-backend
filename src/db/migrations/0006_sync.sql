-- 0006 — Sync: per-device cursors, batch audit, and membership propagation.
--
-- Table contracts:
--   device_sync_state  mutable per-device state, NOT synced (see below)
--   sync_batches       append-only ledger (UPDATE and DELETE revoked), NOT synced
--
-- Neither table goes through app.setup_tenant_table on purpose. That helper
-- stamps server_seq on every write, which would put a device's own pull
-- cursor into the change stream: every pull would publish a change, every
-- change would trigger a pull, and N devices would amplify each other's
-- writes forever. RLS and the tenant-fixed trigger are applied by hand.

SET LOCAL search_path = public, extensions;

-- ===========================================================================
-- device_sync_state
-- ===========================================================================

CREATE TABLE device_sync_state (
  tenant_id            UUID        NOT NULL REFERENCES tenants (id),
  device_id            UUID        NOT NULL,
  -- Highest server_seq the device has confirmed applying. Advanced at the
  -- START of the next pull (the device sends what it has), never on send: a
  -- response lost in transit must not skip changes permanently.
  last_pull_seq        BIGINT      NOT NULL DEFAULT 0,
  last_pull_at         TIMESTAMPTZ,
  last_push_at         TIMESTAMPTZ,
  -- Set by support when a device's local database is known to be corrupt or
  -- when retention has removed tombstones it never saw; the next pull with a
  -- non-zero cursor answers SYNC_RESET_REQUIRED.
  full_resync_required BOOLEAN     NOT NULL DEFAULT false,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

CREATE TRIGGER device_sync_state_updated_at BEFORE UPDATE ON device_sync_state
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER device_sync_state_tenant_fixed BEFORE UPDATE ON device_sync_state
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tenant_change();

ALTER TABLE device_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_sync_state
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The cursor used to live on the synced devices table, which is exactly the
-- amplification loop described above.
ALTER TABLE devices DROP COLUMN last_sync_seq;


-- ===========================================================================
-- sync_batches — one row per push or pull round, for support and dashboards
-- ===========================================================================

CREATE TABLE sync_batches (
  id          UUID        PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  device_id   UUID        NOT NULL,
  kind        TEXT        NOT NULL CHECK (kind IN ('push', 'pull')),
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER     NOT NULL,
  -- push
  operations  INTEGER     NOT NULL DEFAULT 0,
  applied     INTEGER     NOT NULL DEFAULT 0,
  replayed    INTEGER     NOT NULL DEFAULT 0,
  rejected    INTEGER     NOT NULL DEFAULT 0,
  -- pull
  since_seq   BIGINT,
  until_seq   BIGINT,
  changes     INTEGER     NOT NULL DEFAULT 0,
  request_id  TEXT,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

CREATE INDEX sync_batches_device_idx ON sync_batches (tenant_id, device_id, started_at DESC);

ALTER TABLE sync_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_batches_read   ON sync_batches FOR SELECT USING (tenant_id = app.current_tenant_id());
CREATE POLICY sync_batches_append ON sync_batches FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());
SELECT app.restrict_table('sync_batches', ARRAY['UPDATE', 'DELETE']);


-- ===========================================================================
-- users → memberships propagation
--
-- `users` is global and not in the change stream; devices learn about staff
-- through `memberships`. A rename on `users` therefore has to bump the
-- membership rows so they re-enter the stream. SECURITY DEFINER because the
-- rename may come from a tenant whose context cannot see the person's other
-- memberships, and every tenant must hear about it.
-- ===========================================================================

CREATE FUNCTION app.touch_memberships_for_user() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.name      IS DISTINCT FROM OLD.name
  OR NEW.phone     IS DISTINCT FROM OLD.phone
  OR NEW.email     IS DISTINCT FROM OLD.email
  OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    UPDATE memberships SET updated_at = now() WHERE user_id = NEW.id AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_touch_memberships AFTER UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_memberships_for_user();


-- ===========================================================================
-- document_series: the successor of a series across a financial-year boundary
-- ===========================================================================

-- Pull top-ups create next-FY series automatically in the last weeks of the
-- year so an offline device survives 1 April; this index makes the "does the
-- successor exist" lookup a point read.
CREATE INDEX document_series_successor_idx
  ON document_series (tenant_id, outlet_id, counter_id, document_type, fy_start_year)
  WHERE deleted_at IS NULL;

SELECT app.grant_runtime_privileges();
