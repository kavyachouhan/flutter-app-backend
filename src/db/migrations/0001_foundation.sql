-- ===========================================================================
-- 0001 — Foundation: extensions, conventions, and the machinery every table
--        in this schema depends on.
--
-- Nothing here is domain-specific. It establishes:
--   * the tenant context mechanism that RLS policies read
--   * the per-tenant sync sequence that drives offline sync cursors
--   * shared triggers (updated_at, immutability, append-only)
--   * the audit log
--
-- Read `app.current_tenant_id()` and `next_server_seq()` before anything
-- else; the rest of the schema is built on both.
-- ===========================================================================

-- --- Extensions ------------------------------------------------------------

-- gen_random_uuid() and digest(). Present by default on Supabase.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram indexes for the catalogue's fuzzy item search ("find 'onin'" ->
-- "Onion"). Needed by the P0 requirement for name/code/alias search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Removes accents so "jaggery"/"jaggerý" and Hindi transliterations collate
-- sensibly. Used by the catalogue search index.
CREATE EXTENSION IF NOT EXISTS unaccent;


-- --- Schema for internal helpers -------------------------------------------
-- Keeping these out of `public` means a tenant-facing role can be granted
-- rights on public tables without also getting the ability to redefine the
-- functions that enforce isolation.

CREATE SCHEMA IF NOT EXISTS app;


-- ===========================================================================
-- Tenant context
--
-- Every RLS policy in this database resolves the caller's tenant through this
-- function. The API sets `app.tenant_id` with SET LOCAL at the start of each
-- transaction (see src/db/tx.ts).
--
-- SET LOCAL, not SET: the Supabase pooler runs pgbouncer in transaction mode,
-- so a connection is only ours for the length of a transaction. A session-
-- scoped SET would leak one tenant's id into the next tenant's query on the
-- same physical connection — a cross-tenant data leak, and the single worst
-- outcome available in a billing product.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
-- No search_path dependency, so it cannot be shadowed by a caller-controlled
-- schema. Mandatory for anything a SECURITY DEFINER path might reach.
SET search_path = pg_catalog, public
AS $$
  -- The `true` second argument makes this return NULL rather than raising
  -- when the setting is absent. NULL is the safe answer: every policy
  -- compares `tenant_id = app.current_tenant_id()`, and `x = NULL` is NULL,
  -- which fails the policy check. An unset context therefore sees no rows at
  -- all, rather than erroring in a way someone might be tempted to "fix" by
  -- loosening the policy.
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::UUID;
$$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'The tenant for the current transaction, from the app.tenant_id setting. '
  'NULL when unset, which causes every RLS policy to match zero rows.';


-- The acting user, for audit attribution. Same NULL-safe pattern.
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::UUID;
$$;


-- ===========================================================================
-- Sync sequencing
--
-- Offline clients pull changes with "give me everything after cursor N". That
-- only works if sequence order matches commit order. A plain BIGSERIAL does
-- NOT guarantee this: transaction A can take seq 100, transaction B take 101,
-- and B commit first. A client that pulls through 101 then advances its
-- cursor past 100, and never sees that row again — silent, permanent data
-- loss on the device.
--
-- The fix is to allocate the number under a row lock held until commit, so
-- allocation order and commit order are necessarily the same. The lock is
-- per-tenant, so one busy shop never blocks another, and a single shop's
-- write rate (a few per second at most) is nowhere near the contention limit.
-- ===========================================================================

CREATE TABLE app.tenant_sync_counters (
  tenant_id UUID   PRIMARY KEY,
  next_seq  BIGINT NOT NULL DEFAULT 1
);

COMMENT ON TABLE app.tenant_sync_counters IS
  'Per-tenant monotonic counter for sync cursors. Serialises seq allocation '
  'so that sequence order always equals commit order.';

CREATE OR REPLACE FUNCTION app.next_server_seq(p_tenant_id UUID)
RETURNS BIGINT
LANGUAGE sql
SET search_path = pg_catalog, app, public
AS $$
  -- One statement handles both cases with no race between them:
  --   first write for a tenant -> INSERT stores next_seq = 2, returns 1
  --   every later write        -> ON CONFLICT bumps next_seq, returns the
  --                               previous value, holding the row lock until
  --                               commit
  --
  -- RETURNING sees the final row either way, so `next_seq - 1` is the number
  -- just allocated in both paths.
  INSERT INTO app.tenant_sync_counters AS c (tenant_id, next_seq)
  VALUES (p_tenant_id, 2)
  ON CONFLICT (tenant_id) DO UPDATE
    SET next_seq = c.next_seq + 1
  RETURNING c.next_seq - 1;
$$;


-- ===========================================================================
-- Shared triggers
-- ===========================================================================

-- --- updated_at ------------------------------------------------------------
-- Maintained by the database rather than the application: sync conflict
-- resolution compares updated_at across devices, so a single writer that
-- forgets to set it would make a stale row look fresh and win a merge it
-- should have lost.

CREATE OR REPLACE FUNCTION app.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- --- Sync sequence stamping ------------------------------------------------
-- Every insert and update on a synced table gets a fresh server_seq, so a
-- device pulling "everything after N" sees updates as well as creations.

CREATE OR REPLACE FUNCTION app.stamp_server_seq()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, app, public
AS $$
BEGIN
  NEW.server_seq := app.next_server_seq(NEW.tenant_id);
  RETURN NEW;
END;
$$;


-- --- Append-only enforcement -----------------------------------------------
-- For the stock and customer ledgers. Revoking UPDATE/DELETE from the role is
-- the primary control; this trigger is the backstop that also applies to a
-- superuser session or a future role that is granted too much.
--
-- The invariant it protects: a ledger you can edit is not a ledger. Theft
-- detection, stock audits and khata disputes all depend on entries being
-- immutable once written. Corrections are new, offsetting entries.

CREATE OR REPLACE FUNCTION app.forbid_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted. Write a reversing entry instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;


-- --- Tenant immutability ---------------------------------------------------
-- Moving a row between tenants is never a legitimate operation, and an UPDATE
-- that changed tenant_id would pass the RLS USING clause (evaluated on the old
-- row) while writing a row belonging to someone else. WITH CHECK covers this
-- on the policies, and this trigger makes it explicit and uniform.

CREATE OR REPLACE FUNCTION app.forbid_tenant_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;


-- ===========================================================================
-- Convenience: wire the standard triggers onto a table.
--
-- Every tenant-scoped, synced table calls this. Doing it by hand per table
-- invites the one omission that matters — a table without RLS looks exactly
-- like a table with it until someone queries across tenants.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.setup_tenant_table(p_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- updated_at maintenance
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()',
    p_table || '_set_updated_at', p_table);

  -- sync sequence on both insert and update
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION app.stamp_server_seq()',
    p_table || '_stamp_seq', p_table);

  -- tenant_id may never change
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION app.forbid_tenant_change()',
    p_table || '_freeze_tenant', p_table);

  -- Row-level security. FORCE applies the policy to the table owner too;
  -- without it, the role that owns the table bypasses isolation entirely,
  -- which is exactly the footgun that makes people think RLS is working when
  -- it is not.
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_table);

  -- One policy covering all four verbs.
  --   USING      — which existing rows this transaction may see or modify
  --   WITH CHECK — which rows it may write; blocks inserting into, or
  --                updating a row into, another tenant
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON public.%I
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())',
    p_table);

  -- Sync pulls are "WHERE tenant_id = $1 AND server_seq > $2 ORDER BY
  -- server_seq" on every synced table; this index is what makes that an index
  -- scan rather than a sequential one.
  EXECUTE format(
    'CREATE INDEX %I ON public.%I (tenant_id, server_seq)',
    'idx_' || p_table || '_tenant_seq', p_table);
END;
$$;

COMMENT ON FUNCTION app.setup_tenant_table(TEXT) IS
  'Applies the standard tenant-table contract: updated_at, server_seq, '
  'tenant immutability, forced RLS with an isolation policy, and the sync '
  'index. Every tenant-scoped table must call this.';


-- ===========================================================================
-- Audit log
--
-- Deliberately NOT a tenant-scoped table in the usual sense: it is written by
-- the application on every mutating request, and it is append-only. A void, a
-- discount above cap, a price change and a permission grant all land here,
-- because in a billing product "who changed this and when" is a question that
-- gets asked for real — during a theft investigation, or a GST assessment.
-- ===========================================================================

CREATE TABLE audit_log (
  -- BIGSERIAL, not UUID: this table is append-only and read in time order,
  -- and it is the highest-volume table in the schema.
  id           BIGSERIAL   PRIMARY KEY,
  tenant_id    UUID        NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Actor. Nullable because some entries are system-generated (a scheduled
  -- job, a webhook) and pretending otherwise would be a lie in the record.
  user_id      UUID,
  device_id    TEXT,
  ip           INET,

  -- What happened: 'invoice.void', 'item.price_changed', 'user.role_granted'.
  action       TEXT        NOT NULL,
  entity_type  TEXT        NOT NULL,
  entity_id    UUID,

  -- Only the fields that changed, as {field: {from, to}}. Storing whole rows
  -- would duplicate the database into the audit log and drag PII along with
  -- it; storing nothing makes the log useless for reconstruction.
  changes      JSONB,

  -- Free-form context: the reason text on a void, the approving manager on an
  -- over-cap discount.
  metadata     JSONB,

  -- Ties an entry back to the API request and its logs.
  request_id   TEXT
);

CREATE INDEX idx_audit_log_tenant_time ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_log_entity      ON audit_log (tenant_id, entity_type, entity_id);
CREATE INDEX idx_audit_log_action      ON audit_log (tenant_id, action, occurred_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Read and insert only. No UPDATE or DELETE policy exists, so neither is
-- possible regardless of grants: an audit trail that can be edited proves
-- nothing.
CREATE POLICY audit_log_read ON audit_log
  FOR SELECT USING (tenant_id = app.current_tenant_id());

CREATE POLICY audit_log_append ON audit_log
  FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());
