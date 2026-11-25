-- 0055: composition returns come back (Phase 2, user decision Q1, 25 Nov 2026).
--
-- A composition taxpayer files CMP-08 every quarter (by the 18th after the quarter) and GSTR-4
-- for the financial year (by 30 June after it, from FY 2024-25) under Rule 62 (Notification
-- 12/2024-CT; tables as substituted by 05/2026-CT from 01.11.2026). Migration 0049 removed the
-- earlier CMP-08 type; it is added again here together with GSTR-4.
--
-- Table contract:
--   gst_return_periods.return_type adds 'cmp08' (period_month = the quarter's last month) and
--   'gstr4' (period_year = the financial year's start year, period_month = 3).
--
-- No data is touched.

SET LOCAL search_path = public, extensions;

-- destructive-ok: DROP_CONSTRAINT — replaced on the next statement with the composition types added
ALTER TABLE gst_return_periods DROP CONSTRAINT gst_return_periods_return_type_check;
ALTER TABLE gst_return_periods ADD CONSTRAINT gst_return_periods_return_type_check
  CHECK (return_type IN ('gstr1', 'gstr3b', 'gstr9', 'gstr1a', 'cmp08', 'gstr4'));

SELECT app.grant_runtime_privileges();
