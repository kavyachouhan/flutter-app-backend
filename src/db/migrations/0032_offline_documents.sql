-- 0032 — Estimates, sales orders and purchase orders can be made offline.
--
-- A phone that syncs later is told about a row only when it changes, and about a
-- removed row only if the removal is itself a change. An order edit used to DELETE the
-- lines it dropped, so another phone would keep showing them for ever. Lines are now
-- hidden with `deleted_at` instead (the way items and customers already are): the
-- removal is a change like any other and reaches every device.
--
-- Nothing else about a line changes. A removed line never counts toward fulfilment,
-- receipt, reservation or a report; every reader filters `deleted_at IS NULL`.

SET LOCAL search_path = public, extensions;

ALTER TABLE estimate_lines       ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE sales_order_lines    ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE purchase_order_lines ADD COLUMN deleted_at TIMESTAMPTZ;

SELECT app.grant_runtime_privileges();
