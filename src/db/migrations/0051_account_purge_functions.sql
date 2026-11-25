-- 0051 — The account purge, as database functions the API may call.
--
-- 0050 left the purge to an operator script holding the owner's credentials,
-- because deleting a business means switching off the triggers that make
-- bills, payments and ledgers undeletable, and only the tables' owner may do
-- that. These functions move that one privileged step into the database, so
-- the API — which never holds the owner's credentials — can run the purge on
-- its own schedule (src/modules/account/purge.ts).
--
-- The hole they open is narrow on purpose:
--   app.due_business_deletions   lists purge work; ids and dates only.
--   app.purge_deleted_business   deletes ONE business, and only one whose
--                                owner asked for it: an unpurged 'business'
--                                row in account_deletions AND the tenant
--                                already closed (status 'cancelled'). Anything
--                                else is refused. Running it twice is harmless
--                                — the second call finds the work done.
--
-- Stored files are not here: storage is not in the database. The caller
-- deletes them first, and runs this only once they are gone.
--
-- Additive only: two new functions.

SET LOCAL search_path = public, extensions;

-- Only businesses that asked to be deleted AND are already closed: the caller
-- deletes their stored files before purging, so nothing else may be listed.
CREATE FUNCTION app.due_business_deletions(p_due_by TIMESTAMPTZ)
RETURNS TABLE (tenant_id UUID, requested_at TIMESTAMPTZ, purge_due_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT d.tenant_id, d.requested_at, d.purge_due_at
  FROM account_deletions d
  JOIN tenants t ON t.id = d.tenant_id AND t.status = 'cancelled'
  WHERE d.scope = 'business' AND d.purged_at IS NULL
    AND (p_due_by IS NULL OR d.purge_due_at <= p_due_by)
  ORDER BY d.purge_due_at, d.requested_at;
$$;

-- Deletes every row of the business in every table carrying its tenant_id,
-- then the members who belonged to no other business, then the tenant, and
-- marks the request purged. All or nothing: it runs inside the caller's
-- transaction, and any failure rolls the whole business back.
--
-- Returns one row, or no row when there was nothing to purge (never asked for,
-- or already purged — e.g. by another API instance a moment earlier).
CREATE FUNCTION app.purge_deleted_business(p_tenant UUID)
RETURNS TABLE (rows_deleted BIGINT, users_deleted INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tables   TEXT[];
  v_toggled  TEXT[];
  v_members  UUID[];
  v_remaining TEXT[];
  v_held     TEXT[];
  v_table    TEXT;
  v_user     UUID;
  v_count    BIGINT;
  v_deleted  BIGINT := 0;
  v_users    INTEGER := 0;
  v_progress INTEGER;
  v_pass     INTEGER := 0;
  v_left     BIGINT;
BEGIN
  -- The request, locked: a second instance purging at the same moment waits
  -- here, then finds it purged and returns nothing.
  PERFORM 1 FROM account_deletions
   WHERE tenant_id = p_tenant AND scope = 'business' AND purged_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant AND status = 'cancelled') THEN
    RAISE EXCEPTION 'tenant % asked to be deleted but is not closed', p_tenant
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every table with a tenant_id, found now: one added by a later migration
  -- is purged without anyone remembering to list it here.
  SELECT array_agg(format('%I.%I', c.table_schema, c.table_name)
                   ORDER BY c.table_schema, c.table_name)
    INTO v_tables
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
   WHERE c.column_name = 'tenant_id' AND c.table_schema IN ('public', 'app')
     AND NOT (c.table_schema = 'public' AND c.table_name = 'account_deletions');

  -- Bills, payments and ledgers refuse deletion through triggers — rightly,
  -- for the app. This is the one sanctioned exception, for this transaction
  -- only: they are switched back on before it commits, and the ALTERs hold
  -- their locks until then, so no other session ever sees them off.
  v_toggled := v_tables || ARRAY['public.tenants', 'public.account_deletions'];
  FOREACH v_table IN ARRAY v_toggled LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', v_table);
  END LOOP;

  SELECT array_agg(DISTINCT user_id) INTO v_members FROM memberships WHERE tenant_id = p_tenant;

  -- Table by table; a table another one still points at is retried on the
  -- next pass. A pass with no progress is a cycle, and fails the purge.
  v_remaining := v_tables;
  WHILE cardinality(v_remaining) > 0 LOOP
    v_pass := v_pass + 1;
    v_held := ARRAY[]::TEXT[];
    v_progress := 0;
    FOREACH v_table IN ARRAY v_remaining LOOP
      BEGIN
        EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', v_table) USING p_tenant;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_deleted := v_deleted + v_count;
        v_progress := v_progress + 1;
      EXCEPTION WHEN foreign_key_violation THEN
        v_held := v_held || v_table;
      END;
    END LOOP;
    IF cardinality(v_held) > 0 AND v_progress = 0 THEN
      RAISE EXCEPTION 'purge of % made no progress on pass %; still referenced: %',
        p_tenant, v_pass, array_to_string(v_held, ', ');
    END IF;
    v_remaining := v_held;
  END LOOP;

  -- Members of no other business go entirely, unless another business's
  -- record still points at them; those stay erased (the request erased them).
  FOREACH v_user IN ARRAY coalesce(v_members, ARRAY[]::UUID[]) LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM memberships
       WHERE user_id = v_user AND tenant_id <> p_tenant AND deleted_at IS NULL);
    BEGIN
      DELETE FROM users WHERE id = v_user;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_users := v_users + v_count::INTEGER;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END LOOP;

  DELETE FROM tenants WHERE id = p_tenant;
  UPDATE account_deletions SET purged_at = now()
   WHERE tenant_id = p_tenant AND scope = 'business';

  FOREACH v_table IN ARRAY v_toggled LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', v_table);
  END LOOP;

  -- Nothing of the business may be left behind.
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE tenant_id = $1', v_table)
      INTO v_left USING p_tenant;
    IF v_left > 0 THEN
      RAISE EXCEPTION 'purge of % left % rows in %', p_tenant, v_left, v_table;
    END IF;
  END LOOP;

  rows_deleted := v_deleted;
  users_deleted := v_users;
  RETURN NEXT;
END $$;

SELECT app.grant_runtime_privileges();
