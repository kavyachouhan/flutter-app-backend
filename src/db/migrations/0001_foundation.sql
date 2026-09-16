-- 0001 — Foundation: extensions, runtime role, tenant context, sync sequencing,
-- shared triggers, grants and the audit log.

-- Supabase installs extensions into `extensions`; creating the schema keeps this
-- migration valid on a plain Postgres too.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

CREATE SCHEMA IF NOT EXISTS app;

-- Privileges are granted to this NOLOGIN group. The LOGIN role the API connects
-- as is deployment config, so `db:bootstrap` creates it and adds it to the group.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app, extensions TO app_runtime;

-- Functions default to EXECUTE for PUBLIC. The SECURITY DEFINER helpers in
-- `app` must only be callable by the API role.
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- ===========================================================================
-- Tenant context
-- ===========================================================================

-- NULL when unset, and `tenant_id = NULL` is never true, so a transaction
-- without context sees zero rows rather than every tenant's.
CREATE FUNCTION app.current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS UUID
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;


-- ===========================================================================
-- Sync sequencing
--
-- Clients pull "changes after server_seq N", which is only safe if sequence
-- order equals commit order. A BIGSERIAL breaks that: tx A takes 100, tx B
-- takes 101 and commits first, a client pulls through 101 and never sees 100.
-- Allocating under a per-tenant row lock held until commit makes the two
-- orders identical, and the lock is per tenant so shops never block each other.
-- ===========================================================================

CREATE TABLE app.tenant_sync_counters (
  tenant_id UUID   PRIMARY KEY,
  next_seq  BIGINT NOT NULL
);

-- SECURITY DEFINER so the API role needs no privileges on the counter table.
CREATE FUNCTION app.next_server_seq(p_tenant_id UUID) RETURNS BIGINT
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app
AS $$
  INSERT INTO app.tenant_sync_counters AS c (tenant_id, next_seq)
  VALUES (p_tenant_id, 2)
  ON CONFLICT (tenant_id) DO UPDATE SET next_seq = c.next_seq + 1
  RETURNING c.next_seq - 1;
$$;


-- ===========================================================================
-- Shared triggers
-- ===========================================================================

-- Maintained in the database because sync conflict resolution compares
-- updated_at, and one writer forgetting to bump it would let a stale row win.
CREATE FUNCTION app.set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE FUNCTION app.stamp_server_seq() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, app
AS $$ BEGIN NEW.server_seq := app.next_server_seq(NEW.tenant_id); RETURN NEW; END $$;

-- An UPDATE changing tenant_id is evaluated by RLS USING against the old row;
-- WITH CHECK catches it too, but this makes the rule explicit for every table.
CREATE FUNCTION app.forbid_tenant_change() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable on %', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- Backstop for append-only tables; revoked privileges are the primary control.
CREATE FUNCTION app.forbid_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% does not permit %; write a reversing record instead', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

-- Issued documents (invoices, payments) may only change the columns named in
-- the trigger arguments, and a voided document cannot be revived.
CREATE FUNCTION app.guard_document_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION '% % is immutable once issued; only % may change',
      TG_TABLE_NAME, OLD.id, array_to_string(TG_ARGV, ', ')
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION '% % is void and cannot be reinstated', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;


-- ===========================================================================
-- Table contracts
-- ===========================================================================

-- Tables whose rows must never be updated or deleted by the API role.
CREATE TABLE app.restricted_tables (
  table_name TEXT   PRIMARY KEY,
  forbidden  TEXT[] NOT NULL
);

-- Applies the tenant-table contract. Doing it by hand per table invites the one
-- omission that matters: a table without RLS looks identical until queried
-- across tenants.
CREATE FUNCTION app.setup_tenant_table(p_table TEXT) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', p_table || '_updated_at', p_table);
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION app.stamp_server_seq()', p_table || '_server_seq', p_table);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION app.forbid_tenant_change()', p_table || '_tenant_fixed', p_table);

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);
  -- FORCE applies policies to the table owner too; without it the owning role
  -- bypasses isolation and tests run as that role pass falsely.
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON public.%I
                  USING (tenant_id = app.current_tenant_id())
                  WITH CHECK (tenant_id = app.current_tenant_id())', p_table);

  EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, server_seq)', p_table || '_sync_idx', p_table);
END $$;

CREATE FUNCTION app.restrict_table(p_table TEXT, p_forbidden TEXT[]) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO app.restricted_tables (table_name, forbidden) VALUES (p_table, p_forbidden)
  ON CONFLICT (table_name) DO UPDATE SET forbidden = EXCLUDED.forbidden;

  EXECUTE format('CREATE TRIGGER %I BEFORE %s ON public.%I
                  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()',
                 p_table || '_restricted', array_to_string(p_forbidden, ' OR '), p_table);
END $$;

-- Re-run at the end of every migration so new tables are covered.
CREATE FUNCTION app.grant_runtime_privileges() RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_runtime;
  -- Schema-maintenance helpers are for migrations only.
  REVOKE EXECUTE ON FUNCTION app.setup_tenant_table(TEXT), app.restrict_table(TEXT, TEXT[]),
    app.grant_runtime_privileges() FROM app_runtime;

  FOR r IN SELECT table_name, forbidden FROM app.restricted_tables LOOP
    EXECUTE format('REVOKE %s ON public.%I FROM app_runtime', array_to_string(r.forbidden, ', '), r.table_name);
  END LOOP;
END $$;


-- ===========================================================================
-- Audit log
-- ===========================================================================

CREATE TABLE audit_log (
  id           BIGSERIAL   PRIMARY KEY,
  tenant_id    UUID        NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID,
  device_id    UUID,
  ip           INET,
  action       TEXT        NOT NULL,
  entity_type  TEXT        NOT NULL,
  entity_id    UUID,
  -- Changed fields only, as {field: {from, to}}; whole rows would copy PII
  -- into a table nobody purges.
  changes      JSONB,
  metadata     JSONB,
  request_id   TEXT
);

CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx      ON audit_log (tenant_id, entity_type, entity_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_read   ON audit_log FOR SELECT USING (tenant_id = app.current_tenant_id());
CREATE POLICY audit_log_append ON audit_log FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());

SELECT app.restrict_table('audit_log', ARRAY['UPDATE', 'DELETE']);
SELECT app.grant_runtime_privileges();
