-- 0049 — CMP-08 removed from return periods.
--
-- GST Phase 1 covers GSTR-1, GSTR-2B, GSTR-3B, GSTR-9 and the GST reports. The composition
-- return (CMP-08) is out of scope and its code is gone, so a period of that type could be
-- neither prepared nor exported.
--
-- Table contract:
--   gst_return_periods   return_type is one of 'gstr1', 'gstr3b', 'gstr9'.
--
-- No data is touched. If any CMP-08 period exists the migration stops instead of deleting it:
-- a stored or filed return is the shop's record, and removing it needs an explicit decision.
-- Composition billing (bill of supply, tenants.composition_*) is unchanged.

SET LOCAL search_path = public, extensions;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM gst_return_periods WHERE return_type = 'cmp08';
  IF n > 0 THEN
    RAISE EXCEPTION '0049: % CMP-08 return period(s) exist. Export or remove them deliberately before narrowing return_type.', n;
  END IF;
END
$$;

-- destructive-ok: DROP_CONSTRAINT — replaced on the next statement by the same list without 'cmp08'
ALTER TABLE gst_return_periods DROP CONSTRAINT gst_return_periods_return_type_check;
ALTER TABLE gst_return_periods ADD CONSTRAINT gst_return_periods_return_type_check
  CHECK (return_type IN ('gstr1', 'gstr3b', 'gstr9'));

SELECT app.grant_runtime_privileges();
