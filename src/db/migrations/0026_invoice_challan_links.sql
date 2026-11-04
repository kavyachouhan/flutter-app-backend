-- 0026 — Invoice lines can point back to the delivery-challan line they
-- bill. Lets "Convert to Invoice" skip moving stock a second time (the
-- challan already moved it) and lets a challan track how much of itself
-- has been billed so far.

SET LOCAL search_path = public, extensions;

ALTER TABLE invoice_lines
  ADD COLUMN delivery_challan_line_id UUID,
  ADD CONSTRAINT invoice_lines_delivery_challan_line_fk
    FOREIGN KEY (tenant_id, delivery_challan_line_id)
    REFERENCES delivery_challan_lines (tenant_id, id);

CREATE INDEX invoice_lines_delivery_challan_line_idx
  ON invoice_lines (tenant_id, delivery_challan_line_id)
  WHERE delivery_challan_line_id IS NOT NULL;

SELECT app.grant_runtime_privileges();
