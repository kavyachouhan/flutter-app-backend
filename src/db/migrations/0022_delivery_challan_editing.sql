-- 0020 — Delivery challans become editable while open.
--
-- A challan carries none of an invoice's GST/legal weight, so unlike an
-- invoice or purchase bill, fixing a mistake (wrong quantity, wrong item,
-- a line that should not be there) does not need cancel-and-reissue — an
-- in-place edit is fine, as long as nothing on the challan has been
-- invoiced yet. That needs delivery_challan_lines to allow DELETE again
-- (0019 forbade it as the conservative default before an edit feature
-- existed); the "nothing invoiced yet" rule itself belongs in application
-- code, not the database — the same way purchase_order_lines stays fully
-- mutable while an order is open, and the service layer alone decides when
-- it is safe to touch.

SET LOCAL search_path = public, extensions;

DROP TRIGGER delivery_challan_lines_restricted ON delivery_challan_lines;
DELETE FROM app.restricted_tables WHERE table_name = 'delivery_challan_lines';

SELECT app.grant_runtime_privileges();
