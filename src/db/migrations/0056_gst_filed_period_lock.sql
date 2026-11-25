-- 0050: a filed return period is immutable, and filing locks the period on the registration.
--
-- Until now the only thing stopping a filed GSTR-1 / GSTR-3B / GSTR-9 row from being re-prepared
-- or edited was a check in the service; the table guard (0018) still let `status` and
-- `workings` change. A filed return is the shop's record of what was sent to the government
-- and must never change silently (Phase 2 gap analysis §1, defect 1).
--
-- Table contract:
--   gst_return_periods
--     Once status = 'filed', the row's status, workings, totals, prepared_*, filed_* and arn
--     cannot change, and the row cannot be deleted. `notes` may still be edited. Reopening
--     needs a deliberate, audited path (not built): it must set the transaction-local
--     setting app.gst_reopen_period to the period id before updating.
--   app.record_gst_period_lock(registration, level, through, user)
--     Appends a 'lock' event to gst_period_lock_events (append-only since 0037), raises
--     gst_registrations.gstr1_locked_through / gstr3b_locked_through to at least `through`,
--     and bumps lock_epoch. Called by the API when a GSTR-1 or GSTR-3B is recorded as filed.
--
-- No data is touched.

SET LOCAL search_path = public, extensions;

CREATE FUNCTION app.guard_filed_return_period() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status <> 'filed' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF current_setting('app.gst_reopen_period', true) = OLD.id::text THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'return period % is filed and cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.status, NEW.workings, NEW.total_taxable, NEW.total_tax, NEW.prepared_at, NEW.prepared_by,
      NEW.filed_at, NEW.filed_by, NEW.arn)
     IS DISTINCT FROM
     (OLD.status, OLD.workings, OLD.total_taxable, OLD.total_tax, OLD.prepared_at, OLD.prepared_by,
      OLD.filed_at, OLD.filed_by, OLD.arn) THEN
    RAISE EXCEPTION 'return period % is filed; its figures, status and ARN cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gst_return_periods_filed_guard BEFORE UPDATE OR DELETE ON gst_return_periods
  FOR EACH ROW EXECUTE FUNCTION app.guard_filed_return_period();

CREATE FUNCTION app.record_gst_period_lock(
  p_registration UUID,
  p_level        TEXT,
  p_through      DATE,
  p_user         UUID
) RETURNS BIGINT
LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  epoch BIGINT;
BEGIN
  IF p_level NOT IN ('gstr1_filed', 'gstr3b_filed') THEN
    RAISE EXCEPTION 'unknown lock level %', p_level USING ERRCODE = 'check_violation';
  END IF;

  UPDATE gst_registrations
     SET lock_epoch = lock_epoch + 1,
         gstr1_locked_through = CASE WHEN p_level = 'gstr1_filed'
                                     THEN GREATEST(gstr1_locked_through, p_through)
                                     ELSE gstr1_locked_through END,
         gstr3b_locked_through = CASE WHEN p_level = 'gstr3b_filed'
                                      THEN GREATEST(gstr3b_locked_through, p_through)
                                      ELSE gstr3b_locked_through END,
         updated_at = now()
   WHERE id = p_registration
  RETURNING lock_epoch INTO epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GST registration % not found', p_registration USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO gst_period_lock_events (id, tenant_id, registration_id, lock_level, event,
                                      locked_through, lock_epoch, created_by)
  SELECT gen_random_uuid(), r.tenant_id, r.id, p_level, 'lock', p_through, epoch, p_user
    FROM gst_registrations r WHERE r.id = p_registration;

  RETURN epoch;
END $$;

SELECT app.grant_runtime_privileges();
