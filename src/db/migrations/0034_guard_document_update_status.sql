-- 0034 — Let the document guard run on tables that have no `status` column.
--
-- `app.guard_document_update()` ends by refusing to reinstate a void document, which it did by
-- reading `OLD.status`. `itc_register` uses the same guard but has `state`, not `status`, so
-- every UPDATE of it failed with `record "old" has no field "status"`. That is what happens when
-- a purchase bill or debit note that carried input tax credit is cancelled (the credit is
-- marked reversed), and when a credit is matched or claimed — all of them returned a 500.
--
-- The check now reads `status` out of the row as JSON, so a table without one simply has
-- nothing to reinstate. Tables that do have `status` behave exactly as before.

SET LOCAL search_path = public, extensions;

CREATE OR REPLACE FUNCTION app.guard_document_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION '% % is immutable once issued; only % may change',
      TG_TABLE_NAME, OLD.id, array_to_string(TG_ARGV, ', ')
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(OLD) ->> 'status') = 'void' AND (to_jsonb(NEW) ->> 'status') IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION '% % is void and cannot be reinstated', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

SELECT app.grant_runtime_privileges();
