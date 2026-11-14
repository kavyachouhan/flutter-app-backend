-- 0047 — GSTR-9, the annual return, as a saved return period.
--
-- Table contract:
--   gst_return_periods   return_type may now be 'gstr9'. A GSTR-9 period is a financial year:
--                        period_year is the year the FY starts in, period_month is the FY's last
--                        month, and period_from/period_to cover the whole year, so the one column
--                        pair still orders every period correctly. Nothing else changes: the same
--                        prepare -> review -> export -> mark-filed flow and the same snapshot rule
--                        (workings are stored, never recomputed on read) apply.
--
-- No data is touched.

SET LOCAL search_path = public, extensions;

-- destructive-ok: DROP_CONSTRAINT — replaced on the next statement by the same list plus 'gstr9'
ALTER TABLE gst_return_periods DROP CONSTRAINT gst_return_periods_return_type_check;
ALTER TABLE gst_return_periods ADD CONSTRAINT gst_return_periods_return_type_check
  CHECK (return_type IN ('gstr1', 'gstr3b', 'cmp08', 'gstr9'));

SELECT app.grant_runtime_privileges();
